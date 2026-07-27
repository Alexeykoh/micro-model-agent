import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../config/config.js';
import { getTheme } from '../styling/index.js';

/**
 * CLI-команды управления конфигурацией.
 *
 * Команды:
 * - mma config show — показать конфигурацию
 * - mma config reset — сбросить к_defaults
 * - mma config set <key> <value> — установить значение
 *
 * @module cli/config
 */

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
      config.agent = { maxSteps: 100, autoCompact: true, compactThreshold: 0.70, toolTimeout: 120, maxOutputLength: 2000, showThinking: false, skillTokenBudget: 4000, maxSkillsBase: 2, maxSkillsPro: 0, specialist: { enabled: true, triggerThreshold: 2, maxSteps: 10, minErrorLength: 15 }, grounding: { enabled: true, strictMode: false, checkFiles: true, maxMissingGrounding: 3 } };
      saveConfig(config);
      console.log(theme.successMsg('Configuration reset to defaults'));
    });

  configCmd
    .command('set')
    .argument('<key>', 'config key, e.g. agent.maxSteps')
    .argument('<value>', 'new value')
    .description('Set a config value (e.g. agent.maxSteps 200)')
    .action((key: string, value: string) => {
      const config = loadConfig();
      const theme = getTheme();
      const keys = key.split('.');
      let obj: any = config;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in obj)) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      const lastKey = keys[keys.length - 1];
      const num = Number(value);
      obj[lastKey] = isFinite(num) ? num : value;
      saveConfig(config);
      console.log(theme.successMsg(`  ${key} = ${obj[lastKey]}`));
      console.log(`  ${theme.dim('Restart MMA for changes to take effect')}`);
    });

  configCmd
    .command('thinking')
    .aliases(['think'])
    .argument('[state]', 'on/off or true/false')
    .description('Show or toggle model reasoning display')
    .action((state?: string) => {
      const config = loadConfig();
      const theme = getTheme();
      const current = config.agent.showThinking ?? false;

      if (!state) {
        const status = current ? theme.successMsg('ON') : theme.error('OFF');
        console.log(`${theme.highlight('showThinking')}: ${status}`);
        console.log(`  ${theme.dim('Model reasoning is')} ${current ? 'shown' : 'hidden'}`);
        return;
      }

      const newValue = state === 'on' || state === 'true' || state === '1';
      config.agent.showThinking = newValue;
      saveConfig(config);

      const status = newValue ? theme.successMsg('ON') : theme.error('OFF');
      console.log(`${theme.highlight('showThinking')}: ${status}`);
      console.log(`  ${theme.dim('Model reasoning will be')} ${newValue ? 'shown' : 'hidden'}`);
      console.log(`  ${theme.dim('Restart MMA for changes to take effect')}`);
    });
}
