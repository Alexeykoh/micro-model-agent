import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, ensureMmaDir } from './config/config.js';
import { LMStudioNative } from './llm/lmstudio-native.js';
import { OpenAICompat } from './llm/openai-compat.js';
import type { LLMProvider } from './llm/provider.js';
import { ToolRegistry } from './tools/registry.js';
import { runAgentLoop } from './agent/loop.js';
import { runRepl } from './repl/index.js';
import { initTheme, ensureThemeDir, getTheme } from './styling/index.js';
import { createRenderer } from './ui/index.js';
import { getSlashCommands } from './repl/commands.js';
import { registerProviderCommands } from './cli/provider.js';
import { registerModelCommands } from './cli/model.js';
import { registerConfigCommands } from './cli/config.js';
import { registerUpdateCommand } from './cli/update.js';

import { checkProjectSize, setMaxFilesForProject } from './indexer/cache.js';
import { logInfo } from './logger.js';

/**
 * CLI агента MMA.
 *
 * Регистрирует команды:
 * - mma — запуск REPL (по умолчанию)
 * - mma "prompt" — одноразовый запрос
 * - mma model list/use/info — управление моделями
 * - mma provider list/use — управление провайдерами
 * - mma config show/reset/set — управление конфигурацией
 * - mma update check/install — обновление
 *
 * @module cli
 */

/** Интерактивное создание провайдера (с выбором модели) */
async function createProviderInteractive(config: ReturnType<typeof loadConfig>): Promise<{ provider: LLMProvider; modelLabel: string }> {
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
    if (providerName === 'lmstudio') {
      console.log(theme.dim('To use a model from LM Studio:'));
      console.log(theme.dim('  1. Open LM Studio → Local Server tab'));
      console.log(theme.dim('  2. Select a model from the dropdown'));
      console.log(theme.dim('  3. Copy the model ID (e.g. "qwen/qwen3.5-9b")'));
    } else {
      console.log(theme.dim(`Enter the model name for provider "${providerName}"`));
    }
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
    if (providerName === 'lmstudio') {
      console.log(theme.dim('To use a model from LM Studio:'));
      console.log(theme.dim('  1. Open LM Studio → Local Server tab'));
      console.log(theme.dim('  2. Select a model from the dropdown'));
      console.log(theme.dim('  3. Copy the model ID'));
      console.log(theme.dim('  4. Run: mma model add <alias> <model-id> <context>'));
    } else {
      console.log(theme.dim(`Run: mma model add <alias> <model-id> <context-window>`));
    }
    process.exit(1);
  }

  const useLMStudioNative = providerCfg.type === 'lmstudio' || providerName === 'lmstudio';
  const provider: LLMProvider = useLMStudioNative
    ? new LMStudioNative(providerCfg.url, modelCfg!.model, modelCfg!.contextWindow)
    : new OpenAICompat(providerCfg.url, modelCfg!.model, modelCfg!.contextWindow, providerCfg.apiKey);

  return {
    provider,
    modelLabel: `${config.active.provider}/${modelName}`,
  };
}

export function createCli() {
  const program = new Command();

  const __dirname = dirname(fileURLToPath(import.meta.url));
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version;
  } catch { /* fallback */ }

  program
    .name('mma')
    .version(pkgVersion)
    .description('Micro Models Agent (MMA) — LLM agent harness for small models');

  program
    .argument('[prompt]', 'prompt to execute')
    .option('--model <model>', 'model to use')
    .option('--provider <provider>', 'provider to use')
    .option('--mode <mode>', 'agent mode (fast|base|pro)')
    .option('--stdin', 'force read from stdin (for piped mode)')
    .option('--max-files <count>', 'max source files for project map', parseInt);

  registerProviderCommands(program);
  registerModelCommands(program);
  registerConfigCommands(program);
  registerUpdateCommand(program);

  // ─── Setup wizard (re-run) ────────────────────────────
  program
    .command('init')
    .description('Run setup wizard (configure provider and model)')
    .action(async () => {
      const { runSetupWizard } = await import('./setup-wizard.js');
      await runSetupWizard(true);
    });

  // ─── Plugin management ─────────────────────────────────
  const pluginCmd = program.command('plugin').description('plugin management');
  pluginCmd
    .command('list')
    .description('list installed plugins')
    .action(async () => {
      const { PluginManager } = await import('./plugins/manager.js');
      const { loadAllPlugins } = await import('./plugins/loader.js');
      const pm = new PluginManager();
      await loadAllPlugins(pm);
      const plugins = pm.listPlugins();
      const theme = getTheme();
      if (plugins.length === 0) {
        console.log(theme.dim('  No plugins installed.'));
        console.log(theme.dim('  Place plugins in ~/.mma/plugins/ or .mma/plugins/'));
        return;
      }
      console.log(theme.info(`  Installed plugins (${plugins.length}):`));
      for (const p of plugins) {
        const status = p.active ? theme.successMsg('active') : theme.dim('inactive');
        const ver = p.version ? ` v${p.version}` : '';
        console.log(`    ${theme.highlight(p.name)}${ver} — ${status}`);
        if (p.description) console.log(`      ${theme.dim(p.description)}`);
      }
    });

  pluginCmd
    .command('create')
    .argument('<name>', 'plugin name')
    .description('scaffold a new plugin in .mma/plugins/')
    .action(async (name: string) => {
      const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const theme = getTheme();
      const pluginDir = join('.mma', 'plugins', name);
      if (existsSync(pluginDir)) {
        console.log(theme.error(`  Plugin "${name}" already exists at ${pluginDir}`));
        return;
      }
      mkdirSync(pluginDir, { recursive: true });
      const manifest = {
        name,
        version: '0.1.0',
        description: `${name} plugin`,
        entry: 'index.ts',
      };
      writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      writeFileSync(join(pluginDir, 'index.ts'), `import type { AgentPlugin } from '../../src/plugins/types.js';\n\nexport default function createPlugin(): AgentPlugin {\n  return {\n    name: '${name}',\n    version: '0.1.0',\n    async onActivate(ctx) {\n      ctx.logger.info('${name}: activated');\n    },\n  };\n}\n`);
      console.log(theme.successMsg(`  Plugin "${name}" created at ${pluginDir}`));
      console.log(theme.dim(`  Files: manifest.json, index.ts`));
    });

  // Top-level `use <name>` — быстрое переключение модели
  program
    .command('use')
    .argument('<name>', 'model name (e.g. mistralai/ministral-3-3b)')
    .description('Switch to a model (auto-detect or add to current provider)')
    .action((name: string) => {
      const config = loadConfig();
      const theme = getTheme();
      // 1. Exact match in any provider
      for (const [pName, p] of Object.entries(config.providers)) {
        if (p.models[name]) {
          config.active.provider = pName;
          config.active.model = name;
          saveConfig(config);
          console.log(theme.successMsg(`Switched to ${pName}/${name} (${p.models[name].contextWindow}K)`));
          console.log(`  ${theme.dim('Provider:')} ${pName}`);
          console.log(`  ${theme.dim('ID:')}      ${p.models[name].model}`);
          return;
        }
      }
      // 2. provider/model syntax: check if first part is a known provider
      const slashIdx = name.indexOf('/');
      if (slashIdx > 0) {
        const pName = name.slice(0, slashIdx);
        const mName = name.slice(slashIdx + 1);
        if (config.providers[pName]?.models[mName]) {
          config.active.provider = pName;
          config.active.model = mName;
          saveConfig(config);
          console.log(theme.successMsg(`Switched to ${pName}/${mName}`));
          return;
        }
      }
      // 3. Not found — add to current provider with defaults
      const curProvider = config.active.provider;
      const modelKey = slashIdx > 0 ? name.slice(slashIdx + 1) : name;
      config.providers[curProvider].models[modelKey] = {
        model: modelKey,
        contextWindow: 32768,
        params: { temperature: 0.7, max_tokens: 4096 },
      };
      config.active.model = modelKey;
      saveConfig(config);
      console.log(theme.successMsg(`Added model "${modelKey}" to ${curProvider} and set active`));
      console.log(`  ${theme.dim('Context:')} 32768K (default)`);
      console.log(`  ${theme.dim('Tune:')}   mma model params ${modelKey}`);
    });

  program.action(async (prompt?: string) => {
    // Handle --version early (Commander v12 doesn't auto-exit)
    if (process.argv.slice(2).some(a => a === '--version' || a === '-V')) {
      console.log(pkgVersion);
      process.exit(0);
    }

    ensureMmaDir();
    ensureThemeDir();

    // First-run setup wizard
    if (!prompt && process.stdin.isTTY) {
      const { runSetupWizard } = await import('./setup-wizard.js');
      await runSetupWizard();
    }

    const config = loadConfig();
    initTheme(config.theme);

    // Update check is handled inside runRepl (updater.ts checkForUpdate via renderer)

    const providerOpt = program.getOptionValue('provider');
    const modelOpt = program.getOptionValue('model');
    const modeOpt = program.getOptionValue('mode');
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
          const renderer = await createRenderer(undefined);
          runAgentLoop(provider, registry, ctx, undefined, undefined, renderer, config.active.provider, { showThinking: config.agent.showThinking });
          return;
        }
      } catch { /* stdin not available, continue */ }
    }

    if (prompt) {
      const renderer = await createRenderer(undefined);
      runAgentLoop(provider, registry, prompt, undefined, undefined, renderer, config.active.provider, { showThinking: config.agent.showThinking, mode: modeOpt });
    } else {
      const commands = getSlashCommands();
      const renderer = await createRenderer(commands);
      runRepl(provider, registry, modelLabel, renderer, { showThinking: config.agent.showThinking, mode: modeOpt });
    }
  });

  return program;
}
