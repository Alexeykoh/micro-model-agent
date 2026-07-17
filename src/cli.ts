import { Command } from 'commander';
import { loadConfig, ensureMmaDir } from './config/config.js';
import { OpenAICompat } from './llm/openai-compat.js';
import { ToolRegistry } from './tools/registry.js';
import { runAgentLoop } from './agent/loop.js';
import { runRepl } from './repl/index.js';
import { initTheme, ensureThemeDir } from './styling/index.js';
import { createRenderer } from './ui/index.js';
import { registerProviderCommands } from './cli/provider.js';
import { registerModelCommands } from './cli/model.js';
import { registerConfigCommands } from './cli/config.js';

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
    .option('--stdin', 'force read from stdin (for piped mode)')
    .option('--plain', 'use readline terminal instead of TUI')
    .option('--tui', 'enable OpenTUI terminal interface (default)');

  registerProviderCommands(program);
  registerModelCommands(program);
  registerConfigCommands(program);

  program.action(async (prompt?: string) => {
    ensureMmaDir();
    ensureThemeDir();
    const config = loadConfig();
    initTheme(config.theme);

    const providerOpt = program.getOptionValue('provider');
    const modelOpt = program.getOptionValue('model');
    const plainMode = program.getOptionValue('plain') || process.env.MMA_PLAIN === '1';
    const tuiMode = !plainMode;
    if (providerOpt) config.active.provider = providerOpt;
    if (modelOpt) config.active.model = modelOpt;

    const { provider, modelLabel } = createProvider(config);
    const registry = new ToolRegistry();

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
          const renderer = await createRenderer('readline');
          runAgentLoop(provider, registry, ctx, undefined, undefined, renderer, config.active.provider);
          return;
        }
      } catch { /* stdin not available, continue */ }
    }

    if (prompt) {
      const renderer = await createRenderer('readline');
      runAgentLoop(provider, registry, prompt, undefined, undefined, renderer, config.active.provider);
    } else {
      const rendererMode = tuiMode ? 'tui' as const : 'readline' as const;
      const renderer = await createRenderer(rendererMode);
      runRepl(provider, registry, modelLabel, renderer);
    }
  });

  return program;
}
