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
      config.active = { provider: 'lmstudio', model: 'qwen/qwen3.5-9b' };
      config.agent = { maxSteps: 50, autoCompact: true, compactThreshold: 0.85, toolTimeout: 120, maxOutputLength: 2000, filterThinking: true };
      saveConfig(config);
      console.log(theme.successMsg('Configuration reset to defaults'));
    });

  configCmd
    .command('thinking')
    .aliases(['think'])
    .argument('[state]', 'on/off or true/false (toggle if not specified)')
    .description('Show or toggle filterThinking (hide model reasoning)')
    .action((state?: string) => {
      const config = loadConfig();
      const theme = getTheme();
      const current = config.agent.filterThinking ?? true;

      if (!state) {
        const status = current ? theme.successMsg('ON') : theme.error('OFF');
        console.log(`${theme.highlight('filterThinking')}: ${status}`);
        console.log(`  ${theme.dim('Model reasoning is')} ${current ? 'hidden' : 'shown'}`);
        return;
      }

      const newValue = state === 'on' || state === 'true' || state === '1';
      config.agent.filterThinking = newValue;
      saveConfig(config);

      const status = newValue ? theme.successMsg('ON') : theme.error('OFF');
      console.log(`${theme.highlight('filterThinking')}: ${status}`);
      console.log(`  ${theme.dim('Model reasoning will be')} ${newValue ? 'hidden' : 'shown'}`);
      console.log(`  ${theme.dim('Restart MMA for changes to take effect')}`);
    });
}
