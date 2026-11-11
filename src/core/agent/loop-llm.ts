/**
 * Фаза вызова LLM внутри итерации (`TurnCoordinator`, INV-23): reasoning-effort,
 * стрим ответа и его парсинг (text/reasoning/tool_call/usage/warning), обработка
 * ошибок, лог usage/стоимости, `onAfterThink`, context-log и детекция повторных
 * тулов. Вынесено из `core/agent.ts`.
 *
 * Управляющий поток петли возвращается **сигналом** (как и требует вынос):
 * `continue` — повторить итерацию (реактивная компакция / восстановимая ошибка),
 * `break` — остановить цикл, `return` — завершить ход результатом.
 */
import type { AgentDeps } from "../agent";
import type { AgentPhase, AgentResult, OnMeta, OnPhase, ReasoningPhaseInfo } from "../types";
import type { ToolCall, ToolDefinition } from "../../tools/types";
import type { LoopState } from "./loop-state";
import { clearIterationSignals } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import type { ReasoningEffortResolver } from "./reasoning-resolver";
import type { SessionLogger } from "../session-logger";
import type { PolicyState } from "../../modules/reasoning/policy";
import type { ReasoningState } from "../../tools/set-thinking";
import { handleLlmError } from "./loop-llm-errors";
import { issueDirective, clearDirective } from "./directives";
import { detectRepeatedToolCall } from "./loop-repeat";
import { MIN_NARRATION_CHARS } from "./constants";
import { resetSilenceStreak } from "./silence-streak";
import { consumeLlmStream, createLlmStreamResult } from "./loop-llm-stream";
import { predictMaxTokens } from "./harness-budget";
import { buildLlmResponse, finalizeLlmUsage, recordLlmOutput } from "./loop-llm-usage";
import { reasoningLevelsForProvider } from "../../modules/providers/manager";

/** Мутабельный вид `Agent`, которым владеет фаза LLM. */
export interface LlmPhaseHost {
  deps: AgentDeps;
  policyState: PolicyState;
  probePassed: boolean;
  reasoningState: ReasoningState;
  isShutdownRequested(): boolean;
  getAbortSignal(): AbortSignal | undefined;
  emitPhase(
    iteration: number,
    phase: AgentPhase,
    onPhase?: OnPhase,
    info?: ReasoningPhaseInfo,
  ): void;
}

/** Входные данные фазы LLM на одной итерации. */
export interface LlmPhaseInput {
  state: LoopState;
  slog: SessionLogger;
  input: string;
  history: ReturnType<AgentDeps["contextManager"]["getActiveHistory"]>;
  allToolsForBudget: ToolDefinition[];
  tokenTracker: TokenTracker;
  reasoningResolver: ReasoningEffortResolver;
  onChunk?: (chunk: string) => void;
  onMeta?: OnMeta;
  onReasoning?: (reasoning: string) => void;
  onPhase?: OnPhase;
}

/** Результат фазы: вывод модели либо сигнал управления петлёй. */
export type LlmPhaseOutcome =
  | {
      kind: "ok";
      textContent: string;
      reasoningContent: string;
      toolCalls: ToolCall[];
      sawToolCall: boolean;
    }
  | { kind: "continue" }
  | { kind: "break" }
  | { kind: "return"; result: AgentResult };

/** Один запрос к LLM с парсингом стрима; ошибки транслируются в сигнал. */
export async function runLlmPhase(
  host: LlmPhaseHost,
  inp: LlmPhaseInput,
): Promise<LlmPhaseOutcome> {
  const { deps } = host;
  const { state, slog, input, history, allToolsForBudget, tokenTracker, reasoningResolver } = inp;
  const { contextManager, pluginManager, logger, config } = deps;
  const { onChunk, onReasoning, onPhase } = inp;

  const llmStart = Date.now();
  // Сырая оценка на момент отправки — вход калибровки по реальному usage.
  const estimateAtSend = contextManager.getEstimatedTokens();
  const messageCountAtSend = contextManager.getMessageCount?.() ?? 0;
  const baseline = tokenTracker.beginIteration(state, estimateAtSend);
  logger.logLLMRequest(config.model, history.length, input, "agent");

  // Оценка reasoning-effort на итерацию. Сигналы описывают события ПРЕДЫДУЩЕЙ
  // итерации (выставляются на retry-путях перед continue), поэтому политика
  // оценивается ДО очистки сигналов — иначе raise-ветка недостижима.
  // Уровни — из deps (обновляется на reconfigure), fallback на live-резолв
  // (background probe мог обновиться после сборки deps в bootstrap).
  const reasoningLevels =
    deps.reasoningLevels ??
    reasoningLevelsForProvider(
      config.provider,
      deps.capabilitiesProbeRef?.probe,
      config.modelCapabilities?.[config.model],
    );
  const reasoning = reasoningResolver.resolve({
    state,
    policyState: host.policyState,
    reasoningConfig: config.reasoning,
    probePassed: host.probePassed,
    reasoningStrategy: deps.reasoningStrategy,
    reasoningLevels,
    reasoningState: host.reasoningState,
  });

  // Эскалация бюджета после обрыва до ответа: значение живёт ровно один вызов
  // и снимается вместе с остальными per-итерационными сигналами.
  // Прогноз до вызова: крупные файловые задачи сразу уходят на 16k (INV-H1),
  // чтобы не ждать первого обрыва.
  const historyHint = (history?.[history.length - 1] as { content?: unknown })?.content;
  const historyHintText = typeof historyHint === "string" ? historyHint.slice(-500) : undefined;
  const predicted = predictMaxTokens(input, {
    existingOverride: state.iterMaxTokensOverride,
    historyHint: historyHintText,
  });
  const maxTokensOverride = predicted;
  // Очистка per-итерационных сигналов после потребления политикой.
  clearIterationSignals(state);
  // Решение доступно поверхностям ДО старта генерации (INV-R9), поэтому фаза
  // «thinking» эмитится после резолва: индикатор успевает взять уровень.
  host.emitPhase(state.iteration, "thinking", onPhase, reasoning);

  if (reasoning.level) {
    slog.logReasoningControl({
      iteration: state.iteration,
      level: reasoning.level,
      strategy: reasoning.strategy,
      probePassed: host.probePassed,
      source: reasoning.source,
    });
    contextManager.thinkingLevel = reasoning.level;
  }

  // Аккумулятор создаётся до стрима: при обрыве по ошибке частичный текст
  // остаётся виден обработчику (длина ответа в логе).
  const stream = createLlmStreamResult();
  try {
    await consumeLlmStream(
      {
        deps,
        state,
        slog,
        tokenTracker,
        baseline,
        estimateAtSend,
        messageCountAtSend,
        history,
        tools: allToolsForBudget as ToolDefinition[],
        reasoningLevel: reasoning.level,
        maxTokensOverride,
        isShutdownRequested: () => host.isShutdownRequested(),
        getAbortSignal: () => host.getAbortSignal(),
        onChunk,
        onReasoning,
      },
      stream,
    );
  } catch (err) {
    return handleLlmError({
      isShutdownRequested: () => host.isShutdownRequested(),
      err,
      state,
      logger,
      slog,
      pluginManager,
      contextManager,
      model: config.model,
      textLength: stream.textContent.length,
      llmStart,
    });
  } finally {
    host.emitPhase(state.iteration, "done", onPhase);
  }

  // Провайдер не отдал usage — калибровка помечается stale (>1 вызова).
  if (!stream.sawUsage) contextManager.noteMissingUsage?.();

  // Ответ пришёл — условие директивы «ответь сразу» больше не выполняется
  // (иначе она осталась бы стоящей и возвращалась после каждой компакции),
  // а бюджет повтора снова считается свежим.
  clearDirective(contextManager, "truncated");
  state.truncationRetries = 0;

  finalizeLlmUsage({
    state,
    slog,
    tokenTracker,
    contextManager,
    logger,
    model: config.model,
    baseline,
    stream,
    llmStart,
  });

  if (host.isShutdownRequested()) return { kind: "break" };

  // Сообщаем модели, что аргументы тула были невалидным JSON: иначе она видит
  // лишь «пустой» вызов и не знает, что нужно повторить корректно.
  if (stream.malformedToolArgs > 0) {
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${stream.malformedToolArgs} tool call(s) in your last response had invalid JSON arguments and were executed with empty parameters. Re-issue them with valid JSON.</system-summary>`,
    });
  }

  pluginManager.runOnAfterThink(
    { iteration: state.iteration, logger, contextManager },
    buildLlmResponse(stream),
  );
  recordLlmOutput(deps.contextLogger, state, stream);

  // Детекция повторных одинаковых тулов (структурная). Сигнал питает reasoning
  // policy для понижения effort на рутине.
  if (stream.sawToolCall) {
    const repeat = detectRepeatedToolCall(state, stream.toolCalls, deps.exitOnComplete === true);
    if (repeat.repeated) {
      logger.diagnostic(
        "info",
        `Repeated identical tool call detected (iteration ${state.iteration}) — nudging model to finish or change approach`,
      );
      issueDirective(
        contextManager,
        "repeated_call",
        "You just called the same tool with identical arguments. If the task is done, answer with a final text response NOW. If the command failed, try a different approach.",
      );
    }
    if (repeat.stop) {
      if (deps.exitOnComplete) {
        logger.debug("Exit-on-complete: repeated identical status tool call, stopping");
        // Причина остановки фиксируется честно: без неё ход выглядит как
        // «успех с пустым ответом» (§1.1 аудита).
        state.stopReason = "duplicate";
        return { kind: "break" };
      }
      logger.diagnostic(
        "warn",
        `Repeated identical status tool ${state.repeatedToolCount}× (iteration ${state.iteration}) — stopping to avoid an infinite loop`,
      );
      // Жёсткий стоп = тот же путь, что у «duplicate»-батчей: форс-финальный
      // ответ без тулов. Иначе ход завершается успехом с пустым текстом.
      state.finalizeReason = "duplicate";
      state.stopReason = "duplicate";
      return { kind: "break" };
    }
  }

  // Модель заговорила — пользователь увидел текст, серия молчания (индикатор
  // «пользователь в темноте») прервана. Раньше счётчик копился только по пакетам
  // тулов, и видимый ответ вне пакета тишину не прерывал: стрик доживал до
  // жёсткого стопа «инструменты отключены» (ses_mwc2p7hh).
  if (stream.textContent.trim().length >= MIN_NARRATION_CHARS) {
    resetSilenceStreak(state, contextManager);
  }

  return {
    kind: "ok",
    textContent: stream.textContent,
    reasoningContent: stream.reasoningContent,
    toolCalls: stream.toolCalls,
    sawToolCall: stream.sawToolCall,
  };
}
