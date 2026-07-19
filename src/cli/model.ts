import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../config/config.js';
import { getTheme } from '../styling/index.js';

/**
 * CLI-команды управления моделями.
 *
 * Команды:
 * - mma model list — список моделей
 * - mma model use <name> — переключение модели
 * - mma model info — информация о текущей модели
 *
 * @module cli/model
 */

export function registerModelCommands(program: Command): void {
  const modelCmd = program.command('model').description('Manage models');

  modelCmd
    .command('list')
    .description('List models')
    .option('--provider <provider>', 'provider to list models for')
    .action((options: Record<string, any>) => {
      const config = loadConfig();
      const theme = getTheme();
      const providerName = options.provider || config.active.provider;
      const p = config.providers[providerName];
      if (!p) {
        console.error(theme.error(`Provider "${providerName}" not found`));
        process.exit(1);
      }
      for (const [name, m] of Object.entries(p.models)) {
        const active = providerName === config.active.provider && name === config.active.model ? theme.dim(' (active)') : '';
        console.log(`${theme.indent}${theme.highlight(name)}  ${m.contextWindow}K context${active}`);
      }
    });

  modelCmd
    .command('use')
    .argument('<name>', 'model name')
    .description('Switch active model')
    .action((name: string) => {
      const config = loadConfig();
      const theme = getTheme();
      const p = config.providers[config.active.provider];
      if (!p.models[name]) {
        console.error(theme.error(`Model "${name}" not found for provider "${config.active.provider}"`));
        process.exit(1);
      }
      config.active.model = name;
      saveConfig(config);
      console.log(theme.successMsg(`Model: ${name}`));
      console.log(theme.successMsg(`Context: ${p.models[name].contextWindow}K`));
    });

  modelCmd
    .command('add')
    .argument('<name>', 'model name (local alias)')
    .argument('<modelId>', 'model ID on the provider (e.g. qwen3.5-9b-instruct)')
    .argument('<contextWindow>', 'context window size in tokens', parseInt)
    .description('Add a model to the active provider')
    .action((name: string, modelId: string, contextWindow: number) => {
      const config = loadConfig();
      const theme = getTheme();
      const p = config.providers[config.active.provider];
      if (p.models[name]) {
        console.error(theme.error(`Model "${name}" already exists in provider "${config.active.provider}"`));
        process.exit(1);
      }
      p.models[name] = {
        model: modelId,
        contextWindow,
        params: { temperature: 0.7, max_tokens: 4096 },
      };
      saveConfig(config);
      console.log(theme.successMsg(`Model "${name}" added to ${config.active.provider}`));
      console.log(`${theme.indent}${theme.dim('ID:')} ${modelId}`);
      console.log(`${theme.indent}${theme.dim('Context:')} ${contextWindow}K`);
    });

  modelCmd
    .command('remove')
    .argument('<name>', 'model name')
    .description('Remove a model from the active provider')
    .action((name: string) => {
      const config = loadConfig();
      const theme = getTheme();
      const p = config.providers[config.active.provider];
      if (!p.models[name]) {
        console.error(theme.error(`Model "${name}" not found`));
        process.exit(1);
      }
      if (name === config.active.model) {
        console.error(theme.error(`Cannot remove active model "${name}". Switch to another first.`));
        process.exit(1);
      }
      delete p.models[name];
      saveConfig(config);
      console.log(theme.successMsg(`Model "${name}" removed`));
    });

  modelCmd
    .command('current')
    .description('Show active model')
    .action(() => {
      const config = loadConfig();
      const theme = getTheme();
      const p = config.providers[config.active.provider];
      const m = p?.models[config.active.model];
      if (!m) {
        console.log(theme.error('No active model configured'));
        return;
      }
      console.log(`${theme.info('Provider:')} ${config.active.provider}`);
      console.log(`${theme.info('Model:')}   ${config.active.model} (${m.model})`);
      console.log(`${theme.info('Context:')} ${m.contextWindow}K`);
    });

  modelCmd
    .command('params')
    .argument('[name]', 'model name (defaults to active model)')
    .description('Show model parameters')
    .action((name?: string) => {
      const config = loadConfig();
      const theme = getTheme();
      const modelName = name || config.active.model;
      const p = config.providers[config.active.provider];
      const m = p.models[modelName];
      if (!m) {
        console.error(theme.error(`Model "${modelName}" not found`));
        process.exit(1);
      }
      console.log(`${theme.indent}${theme.highlight('Model:')} ${modelName} (${m.model})`);
      console.log(`${theme.indent}${theme.dim('Context:')} ${m.contextWindow}K`);
      console.log(`${theme.indent}${theme.heading('Parameters:')}`);
      for (const [k, v] of Object.entries(m.params)) {
        if (v !== null && v !== undefined) {
          console.log(`    ${theme.dim(k)} = ${theme.info(String(v))}`);
        }
      }
    });

  modelCmd
    .command('set')
    .argument('<name>', 'model name')
    .argument('<params...>', 'key=value pairs (e.g. temperature=0.5 max_tokens=8192)')
    .description('Set model parameters')
    .action((name: string, paramArgs: string[]) => {
      const config = loadConfig();
      const theme = getTheme();
      const p = config.providers[config.active.provider];
      const m = p.models[name];
      if (!m) {
        console.error(theme.error(`Model "${name}" not found`));
        process.exit(1);
      }
      for (const param of paramArgs) {
        const eq = param.indexOf('=');
        if (eq === -1) {
          console.error(`  ${theme.error('Invalid format:')} "${param}" (expected key=value)`);
          continue;
        }
        const key = param.slice(0, eq);
        const raw = param.slice(eq + 1);
        let value: unknown = raw;
        if (raw === 'null' || raw === 'none') value = null;
        else if (raw === 'true') value = true;
        else if (raw === 'false') value = false;
        else if (!isNaN(Number(raw))) value = Number(raw);
        (m.params as Record<string, unknown>)[key] = value;
        console.log(theme.successMsg(`${key} = ${value}`));
      }
      saveConfig(config);
    });
}
