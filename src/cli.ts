import { Command } from 'commander';
import { loadConfig, saveConfig, ensureMmaDir } from './config/config.js';
import { OpenAICompat } from './llm/openai-compat.js';
import { ToolRegistry } from './tools/registry.js';
import { runAgentLoop } from './agent/loop.js';
import { runRepl } from './repl.js';

function createProvider(config: ReturnType<typeof loadConfig>) {
  const providerCfg = config.providers[config.active.provider];
  if (!providerCfg) {
    console.error(`Provider "${config.active.provider}" not found`);
    process.exit(1);
  }
  const modelCfg = providerCfg.models[config.active.model];
  if (!modelCfg) {
    console.error(`Model "${config.active.model}" not found for "${config.active.provider}"`);
    process.exit(1);
  }
  return {
    provider: new OpenAICompat(providerCfg.url, modelCfg.model, modelCfg.contextWindow, providerCfg.apiKey),
    modelLabel: `${config.active.provider}/${config.active.model}`,
  };
}

export function createCli() {
  const program = new Command();

  program
    .name('mma')
    .version('0.1.0')
    .description('MiMo Agent — LLM agent harness for small models');

  program
    .argument('[prompt]', 'prompt to execute')
    .option('--model <model>', 'model to use')
    .option('--provider <provider>', 'provider to use');

  // Provider commands
  const providerCmd = program.command('provider').description('Manage providers');

  providerCmd
    .command('list')
    .description('List all providers')
    .action(() => {
      const config = loadConfig();
      for (const [name, p] of Object.entries(config.providers)) {
        const active = name === config.active.provider ? ' (active)' : '';
        console.log(`  ${name}  ${p.url}${active}`);
      }
    });

  providerCmd
    .command('use')
    .argument('<name>', 'provider name')
    .description('Switch active provider')
    .action((name: string) => {
      const config = loadConfig();
      if (!config.providers[name]) {
        console.error(`Provider "${name}" not found`);
        process.exit(1);
      }
      config.active.provider = name;
      const modelNames = Object.keys(config.providers[name].models);
      if (modelNames.length > 0 && !config.providers[name].models[config.active.model]) {
        config.active.model = modelNames[0];
      }
      saveConfig(config);
      console.log(`  ✓ Provider: ${name} (${config.providers[name].url})`);
      console.log(`  ✓ Model: ${config.active.model}`);
    });

  // Model commands
  const modelCmd = program.command('model').description('Manage models');

  modelCmd
    .command('list')
    .description('List models')
    .option('--provider <provider>', 'provider to list models for')
    .action((options: Record<string, any>) => {
      const config = loadConfig();
      const providerName = options.provider || config.active.provider;
      const p = config.providers[providerName];
      if (!p) {
        console.error(`Provider "${providerName}" not found`);
        process.exit(1);
      }
      for (const [name, m] of Object.entries(p.models)) {
        const active = providerName === config.active.provider && name === config.active.model ? ' (active)' : '';
        console.log(`  ${name}  ${m.contextWindow}K context${active}`);
      }
    });

  modelCmd
    .command('use')
    .argument('<name>', 'model name')
    .description('Switch active model')
    .action((name: string) => {
      const config = loadConfig();
      const p = config.providers[config.active.provider];
      if (!p.models[name]) {
        console.error(`Model "${name}" not found for provider "${config.active.provider}"`);
        process.exit(1);
      }
      config.active.model = name;
      saveConfig(config);
      console.log(`  ✓ Model: ${name}`);
      console.log(`  ✓ Context: ${p.models[name].contextWindow}K`);
    });

  // Default action: prompt or REPL
  program.action((prompt?: string) => {
    ensureMmaDir();
    const config = loadConfig();

    const providerOpt = program.getOptionValue('provider');
    const modelOpt = program.getOptionValue('model');
    if (providerOpt) config.active.provider = providerOpt;
    if (modelOpt) config.active.model = modelOpt;

    const { provider, modelLabel } = createProvider(config);
    const registry = new ToolRegistry();

    if (prompt) {
      runAgentLoop(provider, registry, prompt);
    } else {
      runRepl(provider, registry, modelLabel);
    }
  });

  return program;
}
