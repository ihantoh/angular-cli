/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { Architect, Target } from '@angular-devkit/architect';
import { WorkspaceNodeModulesArchitectHost } from '@angular-devkit/architect/node';
import { json, schema, tags } from '@angular-devkit/core';
import { existsSync } from 'fs';
import * as path from 'path';
import { parseJsonSchemaToOptions } from '../utilities/json-schema';
import { getPackageManager } from '../utilities/package-manager';
import { isPackageNameSafeForAnalytics } from './analytics';
import { BaseCommandOptions, Command } from './command';
import { Arguments, Option } from './interface';
import { parseArguments } from './parser';

export interface ArchitectCommandOptions extends BaseCommandOptions {
  project?: string;
  configuration?: string;
  prod?: boolean;
  target?: string;
}

export abstract class ArchitectCommand<
  T extends ArchitectCommandOptions = ArchitectCommandOptions,
> extends Command<T> {
  protected _architect!: Architect;
  protected _architectHost!: WorkspaceNodeModulesArchitectHost;
  protected _registry!: json.schema.SchemaRegistry;
  protected override readonly useReportAnalytics = false;

  // If this command supports running multiple targets.
  protected multiTarget = false;

  target: string | undefined;
  missingTargetError: string | undefined;

  protected async onMissingTarget(projectName?: string): Promise<void | number> {
    if (this.missingTargetError) {
      this.logger.fatal(this.missingTargetError);

      return 1;
    }

    if (projectName) {
      this.logger.fatal(`Project '${projectName}' does not support the '${this.target}' target.`);
    } else {
      this.logger.fatal(`No projects support the '${this.target}' target.`);
    }

    return 1;
  }

  // eslint-disable-next-line max-lines-per-function
  public override async initialize(options: T & Arguments): Promise<number | void> {
    this._registry = new json.schema.CoreSchemaRegistry();
    this._registry.addPostTransform(json.schema.transforms.addUndefinedDefaults);
    this._registry.useXDeprecatedProvider((msg) => this.logger.warn(msg));

    if (!this.workspace) {
      this.logger.fatal('A workspace is required for this command.');

      return 1;
    }

    this._architectHost = new WorkspaceNodeModulesArchitectHost(
      this.workspace,
      this.workspace.basePath,
    );
    this._architect = new Architect(this._architectHost, this._registry);

    if (!this.target) {
      if (options.help) {
        // This is a special case where we just return.
        return;
      }

      const specifier = this._makeTargetSpecifier(options);
      if (!specifier.project || !specifier.target) {
        this.logger.fatal('Cannot determine project or target for command.');

        return 1;
      }

      return;
    }

    let projectName = options.project;
    if (projectName && !this.workspace.projects.has(projectName)) {
      this.logger.fatal(`Project '${projectName}' does not exist.`);

      return 1;
    }

    const commandLeftovers = options['--'];
    const targetProjectNames: string[] = [];
    for (const [name, project] of this.workspace.projects) {
      if (project.targets.has(this.target)) {
        targetProjectNames.push(name);
      }
    }

    if (projectName && !targetProjectNames.includes(projectName)) {
      return await this.onMissingTarget(projectName);
    }

    if (targetProjectNames.length === 0) {
      return await this.onMissingTarget();
    }

    if (!projectName && commandLeftovers && commandLeftovers.length > 0) {
      const builderNames = new Set<string>();
      const leftoverMap = new Map<string, { optionDefs: Option[]; parsedOptions: Arguments }>();
      let potentialProjectNames = new Set<string>(targetProjectNames);
      for (const name of targetProjectNames) {
        const builderName = await this._architectHost.getBuilderNameForTarget({
          project: name,
          target: this.target,
        });

        if (this.multiTarget) {
          builderNames.add(builderName);
        }

        let builderDesc;
        try {
          builderDesc = await this._architectHost.resolveBuilder(builderName);
        } catch (e) {
          if (e.code === 'MODULE_NOT_FOUND') {
            await this.warnOnMissingNodeModules(this.workspace.basePath);
            this.logger.fatal(`Could not find the '${builderName}' builder's node package.`);

            return 1;
          }
          throw e;
        }

        const optionDefs = await parseJsonSchemaToOptions(
          this._registry,
          builderDesc.optionSchema as json.JsonObject,
        );
        const parsedOptions = parseArguments([...commandLeftovers], optionDefs);
        const builderLeftovers = parsedOptions['--'] || [];
        leftoverMap.set(name, { optionDefs, parsedOptions });

        potentialProjectNames = new Set(
          builderLeftovers.filter((x) => potentialProjectNames.has(x)),
        );
      }

      if (potentialProjectNames.size === 1) {
        projectName = [...potentialProjectNames][0];

        // remove the project name from the leftovers
        const optionInfo = leftoverMap.get(projectName);
        if (optionInfo) {
          const locations = [];
          let i = 0;
          while (i < commandLeftovers.length) {
            i = commandLeftovers.indexOf(projectName, i + 1);
            if (i === -1) {
              break;
            }
            locations.push(i);
          }
          delete optionInfo.parsedOptions['--'];
          for (const location of locations) {
            const tempLeftovers = [...commandLeftovers];
            tempLeftovers.splice(location, 1);
            const tempArgs = parseArguments([...tempLeftovers], optionInfo.optionDefs);
            delete tempArgs['--'];
            if (JSON.stringify(optionInfo.parsedOptions) === JSON.stringify(tempArgs)) {
              options['--'] = tempLeftovers;
              break;
            }
          }
        }
      }

      if (!projectName && this.multiTarget && builderNames.size > 1) {
        this.logger.fatal(tags.oneLine`
          Architect commands with command line overrides cannot target different builders. The
          '${this.target}' target would run on projects ${targetProjectNames.join()} which have the
          following builders: ${'\n  ' + [...builderNames].join('\n  ')}
        `);

        return 1;
      }
    }

    if (!projectName && !this.multiTarget) {
      const defaultProjectName = this.workspace.extensions['defaultProject'] as string;
      if (targetProjectNames.length === 1) {
        projectName = targetProjectNames[0];
      } else if (defaultProjectName && targetProjectNames.includes(defaultProjectName)) {
        projectName = defaultProjectName;
      } else if (options.help) {
        // This is a special case where we just return.
        return;
      } else {
        this.logger.fatal(
          this.missingTargetError || 'Cannot determine project or target for command.',
        );

        return 1;
      }
    }

    options.project = projectName;

    const builderConf = await this._architectHost.getBuilderNameForTarget({
      project: projectName || (targetProjectNames.length > 0 ? targetProjectNames[0] : ''),
      target: this.target,
    });

    let builderDesc;
    try {
      builderDesc = await this._architectHost.resolveBuilder(builderConf);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        await this.warnOnMissingNodeModules(this.workspace.basePath);
        this.logger.fatal(`Could not find the '${builderConf}' builder's node package.`);

        return 1;
      }
      throw e;
    }

    this.description.options.push(
      ...(await parseJsonSchemaToOptions(
        this._registry,
        builderDesc.optionSchema as json.JsonObject,
      )),
    );

    // Update options to remove analytics from options if the builder isn't safelisted.
    for (const o of this.description.options) {
      if (o.userAnalytics && !isPackageNameSafeForAnalytics(builderConf)) {
        o.userAnalytics = undefined;
      }
    }
  }

  private async warnOnMissingNodeModules(basePath: string): Promise<void> {
    // Check for a `node_modules` directory (npm, yarn non-PnP, etc.)
    if (existsSync(path.resolve(basePath, 'node_modules'))) {
      return;
    }

    // Check for yarn PnP files
    if (
      existsSync(path.resolve(basePath, '.pnp.js')) ||
      existsSync(path.resolve(basePath, '.pnp.cjs')) ||
      existsSync(path.resolve(basePath, '.pnp.mjs'))
    ) {
      return;
    }

    const packageManager = await getPackageManager(basePath);
    let installSuggestion = 'Try installing with ';
    switch (packageManager) {
      case 'npm':
        installSuggestion += `'npm install'`;
        break;
      case 'yarn':
        installSuggestion += `'yarn'`;
        break;
      default:
        installSuggestion += `the project's package manager`;
        break;
    }

    this.logger.warn(`Node packages may not be installed. ${installSuggestion}.`);
  }

  async run(options: ArchitectCommandOptions & Arguments) {
    return await this.runArchitectTarget(options);
  }

  protected async runSingleTarget(target: Target, targetOptions: string[]) {
    // We need to build the builderSpec twice because architect does not understand
    // overrides separately (getting the configuration builds the whole project, including
    // overrides).
    const builderConf = await this._architectHost.getBuilderNameForTarget(target);
    let builderDesc;
    try {
      builderDesc = await this._architectHost.resolveBuilder(builderConf);
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND') {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await this.warnOnMissingNodeModules(this.workspace!.basePath);
        this.logger.fatal(`Could not find the '${builderConf}' builder's node package.`);

        return 1;
      }
      throw e;
    }
    const targetOptionArray = await parseJsonSchemaToOptions(
      this._registry,
      builderDesc.optionSchema as json.JsonObject,
    );
    const overrides = parseArguments(targetOptions, targetOptionArray, this.logger);

    const allowAdditionalProperties =
      typeof builderDesc.optionSchema === 'object' && builderDesc.optionSchema.additionalProperties;

    if (overrides['--'] && !allowAdditionalProperties) {
      (overrides['--'] || []).forEach((additional) => {
        this.logger.fatal(`Unknown option: '${additional.split(/=/)[0]}'`);
      });

      return 1;
    }

    await this.reportAnalytics([this.description.name], {
      ...((await this._architectHost.getOptionsForTarget(target)) as unknown as T),
      ...overrides,
    });

    const run = await this._architect.scheduleTarget(target, overrides as json.JsonObject, {
      logger: this.logger,
      analytics: isPackageNameSafeForAnalytics(builderConf) ? this.analytics : undefined,
    });

    const { error, success } = await run.output.toPromise();
    await run.stop();

    if (error) {
      this.logger.error(error);
    }

    return success ? 0 : 1;
  }

  protected async runArchitectTarget(
    options: ArchitectCommandOptions & Arguments,
  ): Promise<number> {
    const extra = options['--'] || [];

    try {
      const targetSpec = this._makeTargetSpecifier(options);
      if (!targetSpec.project && this.target) {
        // This runs each target sequentially.
        // Running them in parallel would jumble the log messages.
        let result = 0;
        for (const project of this.getProjectNamesByTarget(this.target)) {
          result |= await this.runSingleTarget({ ...targetSpec, project } as Target, extra);
        }

        return result;
      } else {
        return await this.runSingleTarget(targetSpec, extra);
      }
    } catch (e) {
      if (e instanceof schema.SchemaValidationException) {
        const newErrors: schema.SchemaValidatorError[] = [];
        for (const schemaError of e.errors) {
          if (schemaError.keyword === 'additionalProperties') {
            const unknownProperty = schemaError.params?.additionalProperty;
            if (unknownProperty in options) {
              const dashes = unknownProperty.length === 1 ? '-' : '--';
              this.logger.fatal(`Unknown option: '${dashes}${unknownProperty}'`);
              continue;
            }
          }
          newErrors.push(schemaError);
        }

        if (newErrors.length > 0) {
          this.logger.error(new schema.SchemaValidationException(newErrors).message);
        }

        return 1;
      } else {
        throw e;
      }
    }
  }

  private getProjectNamesByTarget(targetName: string): string[] {
    const allProjectsForTargetName: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    for (const [name, project] of this.workspace!.projects) {
      if (project.targets.has(targetName)) {
        allProjectsForTargetName.push(name);
      }
    }

    if (this.multiTarget) {
      // For multi target commands, we always list all projects that have the target.
      return allProjectsForTargetName;
    } else {
      // For single target commands, we try the default project first,
      // then the full list if it has a single project, then error out.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const maybeDefaultProject = this.workspace!.extensions['defaultProject'] as string;
      if (maybeDefaultProject && allProjectsForTargetName.includes(maybeDefaultProject)) {
        return [maybeDefaultProject];
      }

      if (allProjectsForTargetName.length === 1) {
        return allProjectsForTargetName;
      }

      throw new Error(`Could not determine a single project for the '${targetName}' target.`);
    }
  }

  private _makeTargetSpecifier(commandOptions: ArchitectCommandOptions): Target {
    let project, target, configuration;

    if (commandOptions.target) {
      [project, target, configuration] = commandOptions.target.split(':');

      if (commandOptions.configuration) {
        configuration = commandOptions.configuration;
      }
    } else {
      project = commandOptions.project;
      target = this.target;
      if (commandOptions.configuration) {
        configuration = `${configuration ? `${configuration},` : ''}${
          commandOptions.configuration
        }`;
      }
    }

    if (!project) {
      project = '';
    }
    if (!target) {
      target = '';
    }

    return {
      project,
      configuration: configuration || '',
      target,
    };
  }
}
