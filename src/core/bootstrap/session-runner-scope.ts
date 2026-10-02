/**
 * Сборка per-runner скоупа: реестр, плагины, ToolContext.
 * Вынесено из `session-runner.ts` (правило #1: ≤300 строк/файл). Чистые
 * билдеры без состояния — фабрика только подставляет свои инстансы.
 */
import type { AppConfig, ModelCapabilities } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import type { SessionManager } from "../../modules/session/index";
import type { ExecutionModule } from "../../modules/execution/module";
import { ToolExecutor } from "../../tools/executor";
import { ToolRegistry } from "../../tools/registry";
import { PluginManager } from "../../modules/plugins/manager";
import type { ToolContext } from "../../tools/types";
import type { PromptBlock } from "../types";
import { buildHiddenToolsBlock } from "../../tools/hidden-tools-block";
import { estimateTokens } from "../../llm/token-counter";
import { BUILTIN_PROVIDERS } from "../../modules/providers/presets";
import { resolveModelCapabilities } from "../../modules/providers/capabilities";

/** Тулы ExecutionModule — в раннер-реестре заменяются привязанными к своему трекеру. */
const EXEC_TOOL_NAMES = new Set(["plan", "plan_step", "todo", "verify"]);

/** `set_thinking` привязан к reasoningState агента — main-версия в клоне не годится. */
const AGENT_BOUND_TOOL_NAMES = new Set([...EXEC_TOOL_NAMES, "set_thinking"]);

/**
 * Плагины, чьи хуки закрываются над shared жизненным циклом (не per-call ctx):
 * execution — свой на раннер; mcp/browser/indexer — onSessionEnd убил бы общие
 * соединения/сессию/вотчер посреди чужих ходов. Остальные инстансы разделяются
 * (хуки ctx-чисты или no-op).
 */
const RUNNER_EXCLUDED_PLUGINS = new Set(["execution", "mcp_module", "browser", "indexer"]);

/**
 * Реестр раннера: все общие определения как есть, exec-тулы — привязанные
 * к трекеру своего ExecutionModule (shared-замыкания дали бы чужой план).
 * `set_thinking` пропускаем — фабрика дорегистрирует свой после сборки агента.
 */
export function buildRunnerRegistry(
  mainRegistry: ToolRegistry,
  runnerExec: ExecutionModule,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of mainRegistry.getAll()) {
    if (AGENT_BOUND_TOOL_NAMES.has(tool.name)) continue;
    registry.register(tool);
  }
  for (const tool of runnerExec.getToolDefinitions()) registry.register(tool);
  return registry;
}

/**
 * Менеджер плагинов раннера: общие инстансы кроме закрытых над shared-жизнью
 * плюс execution-плагин своего трекера.
 */
export function buildRunnerPlugins(
  mainPlugins: PluginManager,
  runnerExec: ExecutionModule,
): PluginManager {
  const runnerPlugins = new PluginManager();
  for (const plugin of mainPlugins.getAllPlugins()) {
    if (RUNNER_EXCLUDED_PLUGINS.has(plugin.name)) continue;
    runnerPlugins.register(plugin);
  }
  runnerPlugins.register(runnerExec.getPlugin());
  return runnerPlugins;
}

/** Входы сборки ToolContext раннера (всё — его собственные инстансы + shared). */
export interface RunnerToolCtxInput {
  configRef: { current: AppConfig };
  logger: Logger;
  baseDir: string;
  contextManager: ContextManager;
  sessionManager: SessionManager;
  sessionId: string;
  activeToolTags: string[];
  /** Живой capabilities-пробник провайдера (та же ссылка, что у main). */
  capabilitiesProbeRef: { probe?: ModelCapabilities };
}

/**
 * ToolContext раннера — зеркало session-phase, но запиненное на его сессию:
 * история/лог пишут ей, `sessionId`/менеджер/контекст — её же, конфиг —
 * живой shared-бокс. Исполнитель и провайдер доставляются после создания
 * (`toolCtx.toolExecutor/llmProvider`), как в session-phase.
 */
export function buildRunnerToolCtx(input: RunnerToolCtxInput): {
  toolCtx: ToolContext;
  runnerTags: string[];
} {
  const { configRef, logger, baseDir, contextManager, sessionManager, sessionId } = input;
  const runnerTags = [...input.activeToolTags];
  const toolCtx = {
    baseDir,
    logger,
    exitOnComplete: false,
    contextManager,
    activeToolTags: runnerTags,
    recursionDepth: 0,
    fileOperationsCount: 0,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        sessionManager.appendMessage({
          role: "tool",
          content: typeof content === "string" ? content : JSON.stringify(content),
          name: type,
          timestamp: new Date().toISOString(),
        });
      },
    },
    sessionLog: {
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
  } as ToolContext;
  Object.defineProperty(toolCtx, "config", {
    get: () => configRef.current,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionId", {
    get: () => sessionId,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionContext", {
    get: () => sessionManager.getSessionContext() ?? undefined,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionManager", {
    get: () => sessionManager,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "capabilities", {
    get: () => {
      const cfg = configRef.current;
      const spec = BUILTIN_PROVIDERS.find((p) => p.type === cfg.provider.type);
      return resolveModelCapabilities(
        spec?.capabilities,
        input.capabilitiesProbeRef.probe,
        cfg.modelCapabilities?.[cfg.model],
      );
    },
    configurable: true,
  });
  return { toolCtx, runnerTags };
}

/** Исполнитель раннера поверх его реестра/контекста/плагинов. */
export function buildRunnerExecutor(
  registry: ToolRegistry,
  toolCtx: ToolContext,
  plugins: PluginManager,
): ToolExecutor {
  return new ToolExecutor(registry, toolCtx, plugins);
}

/** Входы сборки dynamic-блоков раннера. */
export interface RunnerDynamicBlocksInput {
  skillsModule: { getSystemPromptBlock(): PromptBlock | null };
  sessionModule: { getSystemPromptBlock(): PromptBlock | null };
  indexerModule: { getSystemPromptBlock(): PromptBlock | null };
  registry: ToolRegistry;
  runnerTags: string[];
  toolAllowlist?: string[];
}

/**
 * Dynamic-блоки системного промпта раннера (зеркало collectDynamicPromptBlocks,
 * но с сессионным модулем своей сессии — id/имя в промпте её же).
 */
export function buildRunnerDynamicBlocks(input: RunnerDynamicBlocksInput): () => PromptBlock[] {
  return (): PromptBlock[] => {
    const blocks: PromptBlock[] = [];
    const skillsBlock = input.skillsModule.getSystemPromptBlock();
    if (skillsBlock) blocks.push(skillsBlock);
    const sessionBlock = input.sessionModule.getSystemPromptBlock();
    if (sessionBlock) blocks.push(sessionBlock);
    const mapBlock = input.indexerModule.getSystemPromptBlock();
    if (mapBlock) blocks.push(mapBlock);
    const hiddenToolsBlock = input.toolAllowlist
      ? null
      : buildHiddenToolsBlock(input.registry.getAll(), input.runnerTags);
    if (hiddenToolsBlock) {
      blocks.push({
        content: hiddenToolsBlock,
        priority: "low",
        essential: false,
        estimatedTokens: estimateTokens(hiddenToolsBlock),
      });
    }
    return blocks;
  };
}
