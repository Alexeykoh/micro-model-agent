import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { checkForUpdate, getUpdateCommand } from '../updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * CLI-команда обновления MMA.
 *
 * Команды:
 * - mma update check — проверить наличие обновлений
 * - mma update install — установить последнюю версию
 *
 * @module cli/update
 */

export function registerUpdateCommand(program: Command): void {
  const updateCmd = program.command('update')
    .description('Check for updates and install the latest version');

  updateCmd
    .command('check')
    .description('Check if a newer version is available')
    .action(() => {
      const result = checkForUpdate();
      console.log(`Current version: ${result.current}`);
      if (result.available) {
        console.log(`Update available: ${result.latest}`);
        console.log(`Run: ${getUpdateCommand()}`);
      } else {
        console.log(`You're up to date (v${result.latest})`);
      }
    });

  updateCmd
    .command('install')
    .aliases(['apply'])
    .description('Download and install the latest version')
    .action(() => {
      const result = checkForUpdate();
      if (!result.available) {
        console.log(`Already up to date (v${result.current})`);
        return;
      }
      console.log(`Updating ${result.current} → ${result.latest}...`);
      try {
        execSync(getUpdateCommand(), { stdio: 'inherit', windowsHide: true });
        const pkgPath = join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        console.log(`Updated to v${pkg.version}`);
      } catch (e: any) {
        console.error(`Update failed: ${e.message}`);
        console.log(`Try manually: ${getUpdateCommand()}`);
      }
    });

  updateCmd.action(() => {
    const result = checkForUpdate();
    console.log(`Current version: ${result.current}`);
    if (result.available) {
      console.log(`Update available: ${result.latest}`);
      console.log(`\nTo install: ${getUpdateCommand()}`);
      console.log('Or run: mma update install');
    } else {
      console.log(`You're up to date (v${result.latest})`);
    }
  });
}
