/**
 * Публичная поверхность агента (`TurnCoordinator`, INV-23): провенанс, доска
 * контекста/истории, teardown и типовые доступы к зависимостям. Вынесено из
 * `core/agent.ts`; `Agent` остаётся тонкой оболочкой над этими функциями.
 */
import type { ContentPart } from "../../llm/provider";
import type { Message } from "../context/manager";
import type { ToolContext, ToolResult } from "../../tools/types";
import type { PromptBlock } from "../types";
import type { ReasoningLevel } from "../../config/types";
import type { ReasoningState } from "../../tools/set-thinking";
import type { ContextManager } from "../context/manager";
import type { ModuleRegistry } from "../../modules/registry";
import type { SessionManager } from "../../modules/session/manager";
import type { PluginManager } from "../../modules/plugins/manager";
import type { Logger } from "../../logger/app-logger";
import type { ModuleHost } from "../module-host";
import type { SystemPromptBuild } from "./prompt-phase";
import type { AgentDeps } from "./deps";
import { processRegistry } from "../../modules/processes";
import { t } from "../../i18n/index";

/** Провенанс вызывающего: живой провайдер и модель (для стоимости/логов). */
export function callerProvenance(deps: AgentDeps): { provider: string; model: string } {
  // Живое имя: sticky failover переключает запись, не трогая provider.active.
  const live = deps.getProviderName?.();
  if (live) return { provider: live, model: deps.config.model };

  const p = deps.config.provider;
  let providerName = p?.type || "unknown";
  // При записях провайдера — метка активной, чтобы провенанс стоимости
  // различался (напр. "lmstudio" vs "ollama").
  if (p?.entries && p.entries.length > 0) {
    const entry = p.active
      ? p.entries.find((e) => e.label === p.active || e.type === p.active)
      : p.entries[0];
    if (entry) providerName = entry.label || entry.type || providerName;
  }
  return { provider: providerName, model: deps.config.model };
}

/** Ставит уровень reasoning (REPL/CLI). "auto" снимает ручной override. */
export function applyReasoningLevel(state: ReasoningState, level: ReasoningLevel | "auto"): void {
  if (level === "auto") {
    state.manual = false;
    return;
  }
  state.level = level;
  state.manual = true;
}

/** Типизированный доступ к модулям для CLI/REPL (напр. /lsp). */
export function getModule<T>(registry: ModuleRegistry | undefined, name: string): T | undefined {
  return registry?.get(name) as T | undefined;
}

/** Запуск тула по имени из CLI/REPL (например, lsp_check). */
export function runToolByName(deps: AgentDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return deps.toolExecutor.executeByName(name, args);
}

/** Дописывает системный блок на текущий прогон (гайд онбординга). */
export function pushPromptBlock(deps: AgentDeps, block: PromptBlock): void {
  deps.promptBlocks.push(block);
}

/** Убирает ранее запушенный блок (по ссылке). */
export function removePromptBlock(deps: AgentDeps, block: PromptBlock): void {
  const i = deps.promptBlocks.indexOf(block);
  if (i >= 0) deps.promptBlocks.splice(i, 1);
}

/** Тестовый вид текущих блоков промпта. */
export function promptBlocksForTest(deps: AgentDeps): PromptBlock[] {
  return deps.promptBlocks;
}

/** Общий ToolContext (бросает, если bootstrap его не дал). */
export function requireToolContext(deps: AgentDeps): ToolContext {
  if (!deps.toolCtx) throw new Error("toolCtx not provided to Agent");
  return deps.toolCtx;
}

/** Небросающийся вариант `toolContext` для опциональных/lifecycle-проверок. */
export function optionalToolContext(deps: AgentDeps): ToolContext | undefined {
  return deps.toolCtx;
}

/** Сбрасывает контекст (следующий прогон пересоберёт системный промпт). */
export function clearContextOf(contextManager: ContextManager): void {
  contextManager.clear();
}

/** Хост истории: сборка промпта и мутабельный флаг его добавления. */
export interface SetContextHost {
  deps: AgentDeps;
  buildSystemPrompt(): SystemPromptBuild;
  markSystemPromptAdded(): void;
}

/**
 * Заменяет контекст историей (resume): системный промпт + сообщения без дубля system.
 * @param messages сообщения для восстановления.
 */
export function setContext(
  host: SetContextHost,
  messages: Array<{ role: string; content: string | ContentPart[]; name?: string }>,
): void {
  const { contextManager } = host.deps;
  contextManager.clear();
  const { prompt: systemPrompt } = host.buildSystemPrompt();
  contextManager.addMessage({ role: "system", content: systemPrompt });
  host.markSystemPromptAdded();
  for (const msg of messages) {
    if (msg.role === "system") continue;
    contextManager.addMessage({ role: msg.role as Message["role"], content: msg.content, name: msg.name });
  }
  const tainted = contextManager.rehydrateTaint?.() ?? 0;
  if (tainted > 0) {
    host.deps.onDiagnostic?.({
      source: "core",
      operation: "taint.rehydrate",
      kind: "degraded",
      cause: `resume_heuristic: ${tainted}`,
      recoverable: true,
    });
  }
}

/** Зависимости teardown-а хода. */
export interface ShutdownDeps {
  pluginManager: PluginManager;
  logger: Logger;
  sessionManager?: SessionManager;
  contextManager: ContextManager;
  moduleHost?: ModuleHost;
}

/** Хост остановки прогона: сначала abort, затем очистка ресурсов. */
export interface ShutdownHost extends ShutdownDeps {
  requestShutdown(): void;
}

/**
 * Останавливает прогон: abort, kill фоновых процессов, onSessionEnd.
 * Лог сессии НЕ закрываем — сессия ещё активна (закрытие только на
 * реальном конце: exit, удаление сессии).
 * @param sessionId когда задан — убиваются только процессы этой сессии
 * (параллельные раннеры не трогают чужие фоновые процессы; без него —
 * все, как раньше).
 */
export function shutdownAgent(host: ShutdownHost, sessionId?: string): void {
  host.requestShutdown();
  const { pluginManager, logger, sessionManager, contextManager } = host;
  contextManager.onCompact = null;
  const killed = processRegistry.killAll(sessionId);
  if (killed > 0) {
    logger.info(t("env.killed_processes", { count: String(killed) }));
  }
  // Сессионный лог тут НЕ закрываем — сессия ещё активна.
  // Закрытие только на реальном конце (exit, удаление сессии).
  pluginManager.runOnSessionEnd({
    logger,
    sessionManager: sessionManager?.getActiveMeta(),
    contextManager,
  });
  // Жизненный цикл модулей: teardown (закрыть процессы/сокеты). Fire-and-forget
  // — как и `onSessionEnd`; идемпотентность teardown у модулей на совести модуля.
  void host.moduleHost?.dispose();
}
