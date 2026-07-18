import { Command } from 'commander';
import { loadConfig, saveConfig, ensureMmaDir } from './config/config.js';
import { OpenAICompat } from './llm/openai-compat.js';
import { ToolRegistry } from './tools/registry.js';
import { runAgentLoop } from './agent/loop.js';
import { runRepl } from './repl/index.js';
import { initTheme, ensureThemeDir } from './styling/index.js';
import { createRenderer } from './ui/index.js';
import { getSlashCommands } from './repl/commands.js';
import { registerProviderCommands } from './cli/provider.js';
import { registerModelCommands } from './cli/model.js';
import { registerConfigCommands } from './cli/config.js';
import { registerUpdateCommand } from './cli/update.js';
import { checkForUpdateAsync } from './updater.js';
import { checkProjectSize, setMaxFilesForProject } from './indexer/cache.js';
import { logInfo } from './logger.js';

async function createProviderInteractive(config: ReturnType<typeof loadConfig>): Promise<{ provider: OpenAICompat; modelLabel: string }> {
  const theme = initTheme(config.theme);
  const providerName = config.active.provider;
  const providerCfg = config.providers[providerName];
  if (!providerCfg) {
    console.error(theme.error(`Provider "${providerName}" not found`));
    console.log(theme.dim('Add one: mma provider add <name> <url>'));
    process.exit(1);
  }

  let modelName = config.active.model;
  let modelCfg = providerCfg.models[modelName];

  if (!modelCfg && process.stdin.isTTY) {
    const modelKeys = Object.keys(providerCfg.models);
    console.log(theme.warning(`Model "${modelName}" not found in provider "${providerName}"`));
    if (modelKeys.length > 0) {
      console.log(theme.info('Available models:'));
      for (const key of modelKeys) {
        const m = providerCfg.models[key];
        console.log(`  ${theme.highlight(key)} → ${m.model} (${m.contextWindow}K)`);
      }
      console.log('');
    }
    console.log(theme.dim('To use a model from LM Studio:'));
    console.log(theme.dim('  1. Open LM Studio → Local Server tab'));
    console.log(theme.dim('  2. Select a model from the dropdown'));
    console.log(theme.dim('  3. Copy the model ID (e.g. "qwen/qwen3.5-9b")'));
    console.log('');

    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(theme.highlight('Enter model ID to add (or empty to exit): '));

    if (answer.trim()) {
      const newName = answer.trim();
      const ctxAns = await rl.question(theme.highlight('Context window (default 32768): '));
      rl.close();
      const contextWindow = parseInt(ctxAns) || 32768;
      providerCfg.models[newName] = {
        model: newName,
        contextWindow,
        params: { temperature: 0.7, max_tokens: 4096 },
      };
      config.active.model = newName;
      modelName = newName;
      modelCfg = providerCfg.models[newName];
      saveConfig(config);
      console.log(theme.successMsg(`Model "${newName}" added and activated`));
    } else {
      rl.close();
      if (modelKeys.length > 0) {
        console.log(theme.dim('Switch to an existing model:'));
        for (const key of modelKeys) {
          console.log(`  mma model use ${key}`);
        }
      }
      process.exit(1);
    }
  } else if (!modelCfg) {
    console.error(theme.error(`Model "${modelName}" not found for "${providerName}"`));
    console.log(theme.dim('To use a model from LM Studio:'));
    console.log(theme.dim('  1. Open LM Studio → Local Server tab'));
    console.log(theme.dim('  2. Select a model from the dropdown'));
    console.log(theme.dim('  3. Copy the model ID'));
    console.log(theme.dim('  4. Run: mma model add <alias> <model-id> <context>'));
    process.exit(1);
  }

  return {
    provider: new OpenAICompat(providerCfg.url, modelCfg!.model, modelCfg!.contextWindow, providerCfg.apiKey),
    modelLabel: `${config.active.provider}/${modelName}`,
  };
}

export function createCli() {
  const program = new Command();

  program
    .name('mma')
    .version('0.2.25')
    .description('Micro Models Agent (MMA) — LLM agent harness for small models');

  program
    .argument('[prompt]', 'prompt to execute')
    .option('--model <model>', 'model to use')
    .option('--provider <provider>', 'provider to use')
    .option('--stdin', 'force read from stdin (for piped mode)')
    .option('--ink', 'use ink renderer (React terminal UI)')
    .option('--max-files <count>', 'max source files for project map', parseInt);

  registerProviderCommands(program);
  registerModelCommands(program);
  registerConfigCommands(program);
  registerUpdateCommand(program);

  program.action(async (prompt?: string) => {
    ensureMmaDir();
    ensureThemeDir();

    // First-run setup wizard
    if (!prompt && process.stdin.isTTY) {
      const { runSetupWizard } = await import('./setup-wizard.js');
      await runSetupWizard();
    }

    const config = loadConfig();
    initTheme(config.theme);

    // Background version check (non-blocking)
    checkForUpdateAsync();

    const providerOpt = program.getOptionValue('provider');
    const modelOpt = program.getOptionValue('model');
    if (providerOpt) config.active.provider = providerOpt;
    if (modelOpt) config.active.model = modelOpt;
    const maxFilesOpt = program.getOptionValue('maxFiles');
    if (maxFilesOpt) {
      setMaxFilesForProject(process.cwd(), maxFilesOpt);
      logInfo('CLI', `maxFiles set to ${maxFilesOpt} via --max-files`);
    }

    if (!maxFilesOpt && process.stdin.isTTY && !prompt) {
      const count = checkProjectSize(process.cwd());
      if (count > 5000) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n${count} source files found in project. Index for AI context?`);
        console.log('  1) All files (slower, more context)');
        console.log('  2) Limit to 5000 files (faster, good for most tasks)');
        console.log('  3) Custom limit');
        console.log('  4) Skip indexing entirely');
        const ans = await rl.question('Choice [2]: ');
        rl.close();
        const choice = ans.trim();
        if (choice === '1') {
          setMaxFilesForProject(process.cwd(), count);
        } else if (choice === '3') {
          const custom = await rl.question('Max files: ');
          setMaxFilesForProject(process.cwd(), parseInt(custom) || count);
        } else if (choice === '4') {
          setMaxFilesForProject(process.cwd(), 0);
        }
      }
    }

    const { provider, modelLabel } = await createProviderInteractive(config);
    const registry = new ToolRegistry();

    const useInk = program.getOptionValue('ink');
    const renderOptions: { mode?: 'readline' | 'ink' } = { mode: useInk ? 'ink' : 'readline' };

    const forceStdin = program.getOptionValue('stdin');
    const hasStdinData = forceStdin || (!process.stdin.isTTY) || process.env.MMA_STDIN === '1';
    if (hasStdinData) {
      try {
        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => {}, 100);
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        clearTimeout(timeout);
        const stdinContent = Buffer.concat(chunks).toString('utf-8').trim();
        if (stdinContent) {
          const ctx = prompt
            ? `${prompt}\n\nContext from stdin:\n\`\`\`\n${stdinContent.slice(0, 8000)}\n\`\`\``
            : `Context from stdin:\n\`\`\`\n${stdinContent.slice(0, 8000)}\n\`\`\`\n\nAnalyze the above content.`;
          const renderer = await createRenderer(undefined, renderOptions);
          runAgentLoop(provider, registry, ctx, undefined, undefined, renderer, config.active.provider, { showThinking: config.agent.showThinking });
          return;
        }
      } catch { /* stdin not available, continue */ }
    }

    if (prompt) {
      const renderer = await createRenderer(undefined, renderOptions);
      runAgentLoop(provider, registry, prompt, undefined, undefined, renderer, config.active.provider, { showThinking: config.agent.showThinking });
    } else {
      const commands = getSlashCommands();
      const renderer = await createRenderer(commands, renderOptions);
      runRepl(provider, registry, modelLabel, renderer, { showThinking: config.agent.showThinking });
    }
  });

  return program;
}
