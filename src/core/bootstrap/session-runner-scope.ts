/**
 * Сборка per-runner скоупа: реестр, плагины, ToolContext.
 * Вынесено из `session-runner.ts` (правило #1: ≤300 строк/файл). Чистые
 * билдеры без состояния — фабрика только подставляет свои инстансы.
 */
import type { AppConfig, ModelCapabilities } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../core/context/manager";
import type { SessionManager } from "../../modules/session/index";
import type { ExecutionModule } from "../../modules/execution/module";
import { ToolExecutor } from "../../tools/executor";
import { ToolRegistry } from "../../tools/registry";
import { PluginManager } from "../../modules/plugins/manager";
import type { ToolContext, ToolDefinition } from "../../tools/types";
import { subagentLogEntry } from "../../tools/subagent-session-log";
import type { DraftHost } from "../../modules/plugins/drafts";
import type { PromptBlock } from "../types";
import { assembleDynamicPromptBlocks } from "../prompt-assembler";
import { registerOwnedTools } from "../module-host";
import { pluginCapabilitiesBlock } from "../../modules/plugins/capabilities-block";
import { BUILTIN_PROVIDERS } from "../../modules/providers/presets";
import { resolveModelCapabilities } from "../../modules/providers/capabilities";
import { admissionDiagnosticSink } from "./tool-context";

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
  const entries: Array<{ tool: ToolDefinition; owner: string }> = [];
  for (const tool of mainRegistry.getAll()) {
    if (AGENT_BOUND_TOOL_NAMES.has(tool.name)) continue;
    entries.push({ tool, owner: tool.owner });
  }
  for (const tool of runnerExec.getToolDefinitions()) entries.push({ tool, owner: "execution" });
  registerOwnedTools(registry, entries);
  return registry;
}

/**
 * Менеджер плагинов раннера: общие инстансы кроме закрытых над shared-жизнью
 * плюс execution-плагин своего трекера.
 *
 * Deny-list **общий** с главным менеджером (`shareGateWith`): иначе тумблер в
 * вебе выключал бы плагин только в главном агенте, а живая вкладка веба
 * продолжала бы звать его хуки и видеть его тулы.
 */
export function buildRunnerPlugins(
  mainPlugins: PluginManager,
  runnerExec: ExecutionModule,
): PluginManager {
  const runnerPlugins = new PluginManager();
  runnerPlugins.shareGateWith(mainPlugins);
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
  /**
   * Хост черновиков capabilities. Тот же инстанс, что у main: черновик —
   * проектный, и вкладка веба пишет те же файлы, что и терминал.
   */
  draftHost?: DraftHost;
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
      directive: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "directive",
          source: "core",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        } as never);
      },
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          source: "core",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
    subagentLog: (event) => {
      const entry = subagentLogEntry(event);
      if (entry) sessionManager.appendLog(entry);
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
  Object.defineProperty(toolCtx, "pluginDrafts", {
    get: () => input.draftHost,
    configurable: true,
  });
  return { toolCtx, runnerTags };
}

/** Исполнитель раннера поверх его реестра/контекста/плагинов. */
export function buildRunnerExecutor(
  registry: ToolRegistry,
  toolCtx: ToolContext,
  plugins: PluginManager,
  sessionManager: SessionManager,
): ToolExecutor {
  const executor = new ToolExecutor(registry, toolCtx, plugins);
  // INV-15: `admission_degraded` — в сессию раннера, как `verify_error`.
  executor.setDiagnosticSink(admissionDiagnosticSink(sessionManager));
  return executor;
}

/** Входы сборки dynamic-блоков раннера. */
export interface RunnerDynamicBlocksInput {
  /** Живой конфиг раннера (идентичность активной модели). */
  config: AppConfig;
  skillsModule: { getSystemPromptBlock(): PromptBlock | null };
  sessionModule: { getSystemPromptBlock(): PromptBlock | null };
  indexerModule: { getSystemPromptBlock(): PromptBlock | null };
  registry: ToolRegistry;
  runnerTags: string[];
  toolAllowlist?: string[];
  /** Плагин-менеджер раннера — для блока возможностей (INV-16). */
  pluginManager: PluginManager;
}

/**
 * Dynamic-блоки системного промпта раннера. Единый сборщик (INV-16): та же
 * структура, что у main (включая блок возможностей плагинов — раньше он
 * отсутствовал, и сборки разошлись).
 */
export function buildRunnerDynamicBlocks(input: RunnerDynamicBlocksInput): () => PromptBlock[] {
  return (): PromptBlock[] => {
    const capabilitiesBlock = pluginCapabilitiesBlock({
      pluginManager: input.pluginManager,
      pluginsVisible: !input.toolAllowlist,
    });
    return assembleDynamicPromptBlocks({
      model: input.config.model,
      skillsModule: input.skillsModule,
      sessionModule: input.sessionModule,
      indexerModule: input.indexerModule,
      registry: input.registry,
      activeTags: input.runnerTags,
      toolAllowlist: input.toolAllowlist,
      capabilitiesBlock: capabilitiesBlock ? { source: "plugins", ...capabilitiesBlock } : null,
    });
  };
}
