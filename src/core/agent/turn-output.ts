/**
 * Фаза вывода/финализации хода агента (`TurnCoordinator`, INV-23): эмиссия
 * фаз для плагинов и tool-less форс-финал (один вызов модели без инструментов,
 * когда проверить нечем). Вынесено из `core/agent.ts`.
 */
import type { AgentDeps } from "../agent";
import type { AgentPhase, OnPhase, ReasoningPhaseInfo } from "../types";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import type { SessionLogger } from "../session-logger";
import { repairToolCallPairing } from "./tool-pairing";
import { t } from "../../i18n/index";
import { errMsg } from "../../utils";

/** Мутабельный вид `Agent`, которым владеет фаза вывода. */
export interface TurnOutputHost {
  deps: AgentDeps;
  /** Сигнал текущего хода (Esc). */
  abortSignal?: AbortSignal;
  /** Пользователь инициировал shutdown — стрим завершаем досрочно. */
  isShutdownRequested(): boolean;
}

/** Рассылает фазу агента плагинам и наружному колбэку. */
export function emitPhase(
  host: TurnOutputHost,
  iteration: number,
  phase: AgentPhase,
  onPhase?: OnPhase,
  info?: ReasoningPhaseInfo,
): void {
  host.deps.pluginManager.runOnPhase?.(
    {
      iteration,
      logger: host.deps.logger,
      contextManager: host.deps.contextManager,
    },
    phase,
  );
  onPhase?.(phase, info);
}

/**
 * Аварийное завершение без тулов: один вызов модели с пустым набором
 * инструментов. Ответ принимается как финальный; гейты пропускаются — мы
 * остановились именно потому, что проверить нечем. Возвращает текст ответа.
 */
export async function finalizeWithoutTools(
  host: TurnOutputHost,
  state: LoopState,
  tokenTracker: TokenTracker,
  onChunk?: (chunk: string) => void,
  slog?: SessionLogger,
): Promise<string> {
  const { contextManager } = host.deps;
  contextManager.addMessage({
    role: "user",
    content: `<system-summary>${t("exec.finalize_no_tools")}</system-summary>`,
  });
  // Форс-вызов тоже тратит токены и время — учитываем в метриках и стоимости.
  const llmStart = Date.now();
  const baseline = tokenTracker.beginIteration(state, contextManager.getEstimatedTokens());
  const text = await streamFinalAnswer(host, state, tokenTracker, baseline, onChunk);
  const durationMs = Date.now() - llmStart;
  state.totalLlmDuration += durationMs;
  tokenTracker.addCompletionChars(state, text.length);
  if (slog) {
    tokenTracker.logUsage(
      state,
      baseline,
      text,
      contextManager.getEstimatedTokens(),
      state.iteration,
      durationMs,
      slog,
    );
  }
  if (text.trim()) {
    state.lastText = text;
    state.finalAnswerAccepted = true;
    contextManager.addMessage({ role: "assistant", content: text });
    if (host.deps.config.session.autoSave) slog?.saveAssistantMessage(text);
    slog?.logAssistant(text, "", undefined, state.iteration, state.lastFinishReason);
  }
  return text;
}

/** Стрим tool-less ответа для форс-финала; учитывает API-usage по done-чанкам. */
export async function streamFinalAnswer(
  host: TurnOutputHost,
  state: LoopState,
  tokenTracker: TokenTracker,
  baseline: { promptBefore: number; completionBefore: number },
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const { contextManager, logger, llmProvider, pluginManager } = host.deps;
  const history = repairToolCallPairing(contextManager.getActiveHistory());
  let text = "";
  try {
    for await (const chunk of llmProvider.chat(history, [], host.abortSignal, {
      sessionId: host.deps.sessionManager?.getActiveMeta()?.id,
    })) {
      if (host.isShutdownRequested()) break;
      if (chunk.type === "text" && chunk.content) {
        text += chunk.content;
        const out = pluginManager.runOnText(
          { iteration: state.iteration, logger, contextManager },
          chunk.content,
        );
        onChunk?.(out);
      }
      if (chunk.type === "done" && chunk.usage) {
        tokenTracker.recordApiUsage(state, baseline, chunk.usage);
      }
    }
  } catch (e) {
    logger.diagnostic("warn", `finalizeWithoutTools failed: ${errMsg(e)}`);
  }
  return text;
}
