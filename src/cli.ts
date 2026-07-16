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
    .description('Micro Models Agent (MMA) — LLM agent harness for small models');

  program
    .argument('[prompt]', 'prompt to execute')
    .option('--model <model>', 'model to use')
    .option('--provider <provider>', 'provider to use')
    .option('--stdin', 'force read from stdin (for piped mode)');

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

  providerCmd
    .command('add')
    .argument('<name>', 'provider name')
    .argument('<url>', 'API URL (e.g. http://localhost:8000/v1)')
    .description('Add a new provider')
    .action((name: string, url: string) => {
      const config = loadConfig();
      if (config.providers[name]) {
        console.error(`Provider "${name}" already exists. Use "provider use" to switch.`);
        process.exit(1);
      }
      config.providers[name] = {
        type: 'openai-compat',
        url,
        apiKey: null,
        models: {},
      };
      saveConfig(config);
      console.log(`  ✓ Provider "${name}" added (${url})`);
      console.log(`  Add models: mma model add ${name} <model-name> <context-window>`);
    });

  providerCmd
    .command('remove')
    .argument('<name>', 'provider name')
    .description('Remove a provider')
    .action((name: string) => {
      const config = loadConfig();
      if (!config.providers[name]) {
        console.error(`Provider "${name}" not found`);
        process.exit(1);
      }
      if (name === config.active.provider) {
        console.error(`Cannot remove active provider "${name}". Switch to another first.`);
        process.exit(1);
      }
      delete config.providers[name];
      saveConfig(config);
      console.log(`  ✓ Provider "${name}" removed`);
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

  modelCmd
    .command('add')
    .argument('<name>', 'model name (local alias)')
    .argument('<modelId>', 'model ID on the provider (e.g. qwen3.5-9b-instruct)')
    .argument('<contextWindow>', 'context window size in tokens', parseInt)
    .description('Add a model to the active provider')
    .action((name: string, modelId: string, contextWindow: number) => {
      const config = loadConfig();
      const p = config.providers[config.active.provider];
      if (p.models[name]) {
        console.error(`Model "${name}" already exists in provider "${config.active.provider}"`);
        process.exit(1);
      }
      p.models[name] = {
        model: modelId,
        contextWindow,
        params: { temperature: 0.7, max_tokens: 4096 },
      };
      saveConfig(config);
      console.log(`  ✓ Model "${name}" added to ${config.active.provider}`);
      console.log(`  ID: ${modelId}`);
      console.log(`  Context: ${contextWindow}K`);
    });

  modelCmd
    .command('remove')
    .argument('<name>', 'model name')
    .description('Remove a model from the active provider')
    .action((name: string) => {
      const config = loadConfig();
      const p = config.providers[config.active.provider];
      if (!p.models[name]) {
        console.error(`Model "${name}" not found`);
        process.exit(1);
      }
      if (name === config.active.model) {
        console.error(`Cannot remove active model "${name}". Switch to another first.`);
        process.exit(1);
      }
      delete p.models[name];
      saveConfig(config);
      console.log(`  ✓ Model "${name}" removed`);
    });

  modelCmd
    .command('params')
    .argument('[name]', 'model name (defaults to active model)')
    .description('Show model parameters')
    .action((name?: string) => {
      const config = loadConfig();
      const modelName = name || config.active.model;
      const p = config.providers[config.active.provider];
      const m = p.models[modelName];
      if (!m) {
        console.error(`Model "${modelName}" not found`);
        process.exit(1);
      }
      console.log(`  Model: ${modelName} (${m.model})`);
      console.log(`  Context: ${m.contextWindow}K`);
      console.log(`  Parameters:`);
      for (const [k, v] of Object.entries(m.params)) {
        if (v !== null && v !== undefined) {
          console.log(`    ${k} = ${v}`);
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
      const p = config.providers[config.active.provider];
      const m = p.models[name];
      if (!m) {
        console.error(`Model "${name}" not found`);
        process.exit(1);
      }
      for (const param of paramArgs) {
        const eq = param.indexOf('=');
        if (eq === -1) {
          console.error(`  Invalid format: "${param}" (expected key=value)`);
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
        console.log(`  ✓ ${key} = ${value}`);
      }
      saveConfig(config);
    });

  // Config commands
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
      config.providers = {};
      config.active = { provider: 'lmstudio', model: 'qwen3.5-9b' };
      config.agent = { maxSteps: 50, autoCompact: true, compactThreshold: 0.85, toolTimeout: 120, maxOutputLength: 2000 };
      saveConfig(config);
      console.log('  ✓ Configuration reset to defaults');
    });

  // Default action: prompt or REPL
  program.action(async (prompt?: string) => {
    ensureMmaDir();
    const config = loadConfig();

    const providerOpt = program.getOptionValue('provider');
    const modelOpt = program.getOptionValue('model');
    if (providerOpt) config.active.provider = providerOpt;
    if (modelOpt) config.active.model = modelOpt;

    const { provider, modelLabel } = createProvider(config);
    const registry = new ToolRegistry();

    // Piped mode: works with bash AND PowerShell
    // PowerShell: "text" | mma --stdin "prompt"
    // Bash: echo "text" | mma "prompt"
    const forceStdin = program.getOptionValue('stdin');
    const hasStdinData = forceStdin || (!process.stdin.isTTY) || process.env.MMA_STDIN === '1';
    if (hasStdinData) {
      try {
        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => {}, 100); // keep event loop alive briefly
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        clearTimeout(timeout);
        const stdinContent = Buffer.concat(chunks).toString('utf-8').trim();
        if (stdinContent) {
          const ctx = prompt
            ? `${prompt}\n\nContext from stdin:\n\`\`\`\n${stdinContent.slice(0, 8000)}\n\`\`\``
            : `Context from stdin:\n\`\`\`\n${stdinContent.slice(0, 8000)}\n\`\`\`\n\nAnalyze the above content.`;
          runAgentLoop(provider, registry, ctx);
          return;
        }
      } catch { /* stdin not available, continue */ }
    }

    if (prompt) {
      runAgentLoop(provider, registry, prompt);
    } else {
      runRepl(provider, registry, modelLabel);
    }
  });

  return program;
}
