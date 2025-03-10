/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { execSync } from 'child_process';
import nodeModule from 'module';
import { Command } from '../models/command';
import { colors } from '../utilities/color';
import { getPackageManager } from '../utilities/package-manager';
import { Schema as VersionCommandSchema } from './version';

/**
 * Major versions of Node.js that are officially supported by Angular.
 */
const SUPPORTED_NODE_MAJORS = [12, 14, 16];

interface PartialPackageInfo {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export class VersionCommand extends Command<VersionCommandSchema> {
  public static aliases = ['v'];

  private readonly localRequire = nodeModule.createRequire(__filename);
  // Trailing slash is used to allow the path to be treated as a directory
  private readonly workspaceRequire = nodeModule.createRequire(this.context.root + '/');

  async run() {
    const cliPackage: PartialPackageInfo = this.localRequire('../package.json');
    let workspacePackage: PartialPackageInfo | undefined;
    try {
      workspacePackage = this.workspaceRequire('./package.json');
    } catch {}

    const [nodeMajor] = process.versions.node.split('.').map((part) => Number(part));
    const unsupportedNodeVersion = !SUPPORTED_NODE_MAJORS.includes(nodeMajor);

    const patterns = [
      /^@angular\/.*/,
      /^@angular-devkit\/.*/,
      /^@bazel\/.*/,
      /^@ngtools\/.*/,
      /^@nguniversal\/.*/,
      /^@schematics\/.*/,
      /^rxjs$/,
      /^typescript$/,
      /^ng-packagr$/,
      /^webpack$/,
    ];

    const packageNames = [
      ...Object.keys(cliPackage.dependencies || {}),
      ...Object.keys(cliPackage.devDependencies || {}),
      ...Object.keys(workspacePackage?.dependencies || {}),
      ...Object.keys(workspacePackage?.devDependencies || {}),
    ];

    const versions = packageNames
      .filter((x) => patterns.some((p) => p.test(x)))
      .reduce((acc, name) => {
        if (name in acc) {
          return acc;
        }

        acc[name] = this.getVersion(name);

        return acc;
      }, {} as { [module: string]: string });

    const ngCliVersion = cliPackage.version;
    let angularCoreVersion = '';
    const angularSameAsCore: string[] = [];

    if (workspacePackage) {
      // Filter all angular versions that are the same as core.
      angularCoreVersion = versions['@angular/core'];
      if (angularCoreVersion) {
        for (const angularPackage of Object.keys(versions)) {
          if (
            versions[angularPackage] == angularCoreVersion &&
            angularPackage.startsWith('@angular/')
          ) {
            angularSameAsCore.push(angularPackage.replace(/^@angular\//, ''));
            delete versions[angularPackage];
          }
        }

        // Make sure we list them in alphabetical order.
        angularSameAsCore.sort();
      }
    }

    const namePad = ' '.repeat(
      Object.keys(versions).sort((a, b) => b.length - a.length)[0].length + 3,
    );
    const asciiArt = `
     _                      _                 ____ _     ___
    / \\   _ __   __ _ _   _| | __ _ _ __     / ___| |   |_ _|
   / △ \\ | '_ \\ / _\` | | | | |/ _\` | '__|   | |   | |    | |
  / ___ \\| | | | (_| | |_| | | (_| | |      | |___| |___ | |
 /_/   \\_\\_| |_|\\__, |\\__,_|_|\\__,_|_|       \\____|_____|___|
                |___/
    `
      .split('\n')
      .map((x) => colors.red(x))
      .join('\n');

    this.logger.info(asciiArt);
    this.logger.info(
      `
      Angular CLI: ${ngCliVersion}
      Node: ${process.versions.node}${unsupportedNodeVersion ? ' (Unsupported)' : ''}
      Package Manager: ${await this.getPackageManager()}
      OS: ${process.platform} ${process.arch}

      Angular: ${angularCoreVersion}
      ... ${angularSameAsCore
        .reduce<string[]>((acc, name) => {
          // Perform a simple word wrap around 60.
          if (acc.length == 0) {
            return [name];
          }
          const line = acc[acc.length - 1] + ', ' + name;
          if (line.length > 60) {
            acc.push(name);
          } else {
            acc[acc.length - 1] = line;
          }

          return acc;
        }, [])
        .join('\n... ')}

      Package${namePad.slice(7)}Version
      -------${namePad.replace(/ /g, '-')}------------------
      ${Object.keys(versions)
        .map((module) => `${module}${namePad.slice(module.length)}${versions[module]}`)
        .sort()
        .join('\n')}
    `.replace(/^ {6}/gm, ''),
    );

    if (unsupportedNodeVersion) {
      this.logger.warn(
        `Warning: The current version of Node (${process.versions.node}) is not supported by Angular.`,
      );
    }
  }

  private getVersion(moduleName: string): string {
    let packageInfo: PartialPackageInfo | undefined;
    let cliOnly = false;

    // Try to find the package in the workspace
    try {
      packageInfo = this.workspaceRequire(`${moduleName}/package.json`);
    } catch {}

    // If not found, try to find within the CLI
    if (!packageInfo) {
      try {
        packageInfo = this.localRequire(`${moduleName}/package.json`);
        cliOnly = true;
      } catch {}
    }

    let version: string | undefined;

    // If found, attempt to get the version
    if (packageInfo) {
      try {
        version = packageInfo.version + (cliOnly ? ' (cli-only)' : '');
      } catch {}
    }

    return version || '<error>';
  }

  private async getPackageManager(): Promise<string> {
    try {
      const manager = await getPackageManager(this.context.root);
      const version = execSync(`${manager} --version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          //  NPM updater notifier will prevents the child process from closing until it timeout after 3 minutes.
          NO_UPDATE_NOTIFIER: '1',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        },
      }).trim();

      return `${manager} ${version}`;
    } catch {
      return '<error>';
    }
  }
}
