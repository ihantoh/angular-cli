import { createProjectFromAsset } from '../../utils/assets';
import { expectFileMatchToExist } from '../../utils/fs';
import { installPackage, installWorkspacePackages, setRegistry } from '../../utils/packages';
import { ng, noSilentNg } from '../../utils/process';
import { isPrereleaseCli, useCIChrome, useCIDefaults } from '../../utils/project';

export default async function () {
  // We need to use the public registry because in the local NPM server we don't have
  // older versions @angular/cli packages which would cause `npm install` during `ng update` to fail.
  try {
    await createProjectFromAsset('9.0-project', true, true);

    await setRegistry(false);
    await installWorkspacePackages();

    // Update Angular to 10
    await installPackage('@angular/cli@9');
    const { stdout } = await ng('update', '@angular/cli@10.x', '@angular/core@10.x');
    if (!stdout.includes("Executing migrations of package '@angular/cli'")) {
      throw new Error('Update did not execute migrations. OUTPUT: \n' + stdout);
    }

    // Update Angular to 11
    await ng('update', '@angular/cli@11', '@angular/core@11');

    // Update Angular to 12
    await ng('update', '@angular/cli@12', '@angular/core@12');

    // Update Angular to 13
    await ng('update', '@angular/cli@13', '@angular/core@13');
  } finally {
    await setRegistry(true);
  }

  // Update Angular current build
  const extraUpdateArgs = isPrereleaseCli() ? ['--next', '--force'] : [];
  // For the latest/next release we purposely don't add `@angular/core`.
  // This is due to our bumping strategy, which causes a period were `@angular/cli@latest` (v12.0.0) `@angular/core@latest` (v11.2.x)
  // are of different major/minor version on the local NPM server. This causes `ng update` to fail.
  // NB: `ng update @angula/cli` will still cause `@angular/core` packages to be updated.
  await ng('update', '@angular/cli', ...extraUpdateArgs);

  // Setup testing to use CI Chrome.
  await useCIChrome('./');
  await useCIChrome('./e2e/');
  await useCIDefaults('nine-project');

  // Run CLI commands.
  await ng('generate', 'component', 'my-comp');
  await ng('test', '--watch=false');
  await ng('e2e');
  await ng('e2e', '--configuration=production');

  // Verify project now creates bundles
  await noSilentNg('build', '--configuration=production');
  await expectFileMatchToExist('dist/nine-project/', /main\.[0-9a-f]{16}\.js/);
}
