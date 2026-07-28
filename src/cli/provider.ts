import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../config/config.js';
import { getTheme } from '../styling/index.js';

/**
 * CLI-команды управления провайдерами LLM.
 *
 * Команды:
 * - mma provider list — список провайдеров
 * - mma provider use <name> — переключение провайдера
 *
 * @module cli/provider
 */

export function registerProviderCommands(program: Command): void {
  const providerCmd = program.command('provider').description('Manage providers');

  providerCmd
    .command('list')
    .description('List all providers')
    .action(() => {
      const config = loadConfig();
      const theme = getTheme();
      for (const [name, p] of Object.entries(config.providers)) {
        const active = name === config.active.provider ? theme.dim(' (active)') : '';
        console.log(`${theme.indent}${theme.highlight(name)}  ${p.url}${active}`);
      }
    });

  providerCmd
    .command('use')
    .argument('<name>', 'provider name')
    .description('Switch active provider')
    .action((name: string) => {
      const config = loadConfig();
      const theme = getTheme();
      if (!config.providers[name]) {
        console.error(theme.error(`Provider "${name}" not found`));
        process.exit(1);
      }
      config.active.provider = name;
      const modelNames = Object.keys(config.providers[name].models);
      if (modelNames.length > 0 && !config.providers[name].models[config.active.model]) {
        config.active.model = modelNames[0];
      }
      saveConfig(config);
      console.log(theme.successMsg(`Provider: ${name} (${config.providers[name].url})`));
      console.log(theme.successMsg(`Model: ${config.active.model}`));
    });

  providerCmd
    .command('add')
    .argument('<name>', 'provider name')
    .argument('<url>', 'API URL (e.g. https://openrouter.ai/api/v1)')
    .option('--api-key <key>', 'API key')
    .description('Add a new provider')
    .action((name: string, url: string, options: { apiKey?: string }) => {
      const config = loadConfig();
      const theme = getTheme();
      if (config.providers[name]) {
        console.error(theme.error(`Provider "${name}" already exists. Use "provider use" to switch.`));
        process.exit(1);
      }
      config.providers[name] = {
        type: 'openai-compat',
        url,
        apiKey: options.apiKey || null,
        models: {},
      };
      saveConfig(config);
      console.log(theme.successMsg(`Provider "${name}" added (${url})`));
      if (options.apiKey) console.log(`  ${theme.dim('API key:')} ${'*'.repeat(options.apiKey.length - 4)}${options.apiKey.slice(-4)}`);
      console.log(`  Add models: ${theme.info(`mma model add ${name} <model-name> <context-window>`)}`);
    });

  providerCmd
    .command('remove')
    .argument('<name>', 'provider name')
    .description('Remove a provider')
    .action((name: string) => {
      const config = loadConfig();
      const theme = getTheme();
      if (!config.providers[name]) {
        console.error(theme.error(`Provider "${name}" not found`));
        process.exit(1);
      }
      if (name === config.active.provider) {
        console.error(theme.error(`Cannot remove active provider "${name}". Switch to another first.`));
        process.exit(1);
      }
      delete config.providers[name];
      saveConfig(config);
      console.log(theme.successMsg(`Provider "${name}" removed`));
    });
}
