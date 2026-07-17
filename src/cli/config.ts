import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../config/config.js';
import { getTheme } from '../styling/index.js';

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command('config').description('Manage configuration');

  configCmd
    .command('show')
    .description('Show current configuration')
    .action(() => {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
    });

  configCmd
    .command('reset')
    .description('Reset config to defaults')
    .action(() => {
      const config = loadConfig();
      const theme = getTheme();
      config.providers = {};
      config.active = { provider: 'lmstudio', model: 'qwen3.5-9b' };
      config.agent = { maxSteps: 50, autoCompact: true, compactThreshold: 0.85, toolTimeout: 120, maxOutputLength: 2000 };
      saveConfig(config);
      console.log(theme.successMsg('Configuration reset to defaults'));
    });
}
