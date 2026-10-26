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
import type { AgentPhase, AgentResult, LLMResponse, OnMeta, OnPhase, ReasoningPhaseInfo } from "../types";
import type { ToolCall, ToolDefinition } from "../../tools/types";
import type { LoopState } from "./loop-state";
import { clearIterationSignals } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import type { ReasoningEffortResolver } from "./reasoning-resolver";
import type { SessionLogger } from "../session-logger";
import type { PolicyState } from "../../modules/reasoning/policy";
import type { ReasoningState } from "../../tools/set-thinking";
import { LlmError } from "../../llm/llm-errors";
import { MAX_LLM_ERROR_RETRIES } from "./constants";
import { t } from "../../i18n/index";
import { issueDirective } from "./directives";
import { detectRepeatedToolCall } from "./loop-repeat";

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
  const { contextManager, pluginManager, logger, llmProvider, config } = deps;
  const { onChunk, onReasoning, onPhase } = inp;

  let textContent = "";
  let reasoningContent = "";
  const toolCalls: ToolCall[] = [];
  let sawToolCall = false;
  let sawUsage = false;
  let emittedReasoning = false;
  let malformedToolArgs = 0;

  const llmStart = Date.now();
  // Сырая оценка на момент отправки — вход калибровки по реальному usage.
  const estimateAtSend = contextManager.getEstimatedTokens();
  const messageCountAtSend = contextManager.getMessageCount?.() ?? 0;
  const baseline = tokenTracker.beginIteration(state, estimateAtSend);
  logger.logLLMRequest(config.model, history.length, input, "agent");

  // Оценка reasoning-effort на итерацию. Сигналы описывают события ПРЕДЫДУЩЕЙ
  // итерации (выставляются на retry-путях перед continue), поэтому политика
  // оценивается ДО очистки сигналов — иначе raise-ветка недостижима.
  const reasoning = reasoningResolver.resolve({
    state,
    policyState: host.policyState,
    reasoningConfig: config.reasoning,
    probePassed: host.probePassed,
    reasoningStrategy: deps.reasoningStrategy,
    reasoningState: host.reasoningState,
  });

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

  try {
    for await (const chunk of llmProvider.chat(
      history,
      allToolsForBudget as ToolDefinition[],
      host.getAbortSignal(),
      reasoning.level
        ? {
            reasoningEffort: reasoning.level,
            sessionId: deps.sessionManager?.getActiveMeta()?.id,
          }
        : { sessionId: deps.sessionManager?.getActiveMeta()?.id },
    )) {
      if (host.isShutdownRequested()) break;
      if (chunk.type === "text" && chunk.content) {
        if (emittedReasoning && !textContent) {
          onReasoning?.("\n\n");
        }
        textContent += chunk.content;
        const textOut = pluginManager.runOnText(
          { iteration: state.iteration, logger, contextManager },
          chunk.content,
        );
        onChunk?.(textOut);
      }
      if (chunk.type === "reasoning" && chunk.content) {
        reasoningContent += chunk.content;
        if (config.showReasoning) {
          const metaOut = pluginManager.runOnMeta(
            { iteration: state.iteration, logger, contextManager },
            chunk.content,
          );
          if (metaOut) {
            onReasoning?.(metaOut);
          }
          emittedReasoning = true;
        }
      }
      if (chunk.type === "tool_call" && chunk.toolCall) {
        sawToolCall = true;
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(chunk.toolCall.arguments);
        } catch {
          // Битый JSON аргументов раньше молча превращался в `{}` — модель звала
          // тул с пустыми параметрами и не понимала причины. Логируем и сообщаем.
          parsedArgs = {};
          malformedToolArgs++;
          logger.diagnostic(
            "warn",
            `Invalid JSON in tool_call arguments for "${chunk.toolCall.name}" (${chunk.toolCall.arguments.length} chars) — passing {}`,
          );
          slog.logError({
            source: `tool:${chunk.toolCall.name}`,
            operation: "tool.args_parse",
            kind: "degraded",
            cause: `invalid JSON arguments (${chunk.toolCall.arguments.length} chars), passing {}`,
            detail: { toolCallId: chunk.toolCall.id },
          });
        }
        toolCalls.push({
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          arguments: parsedArgs,
        });
      }
      if (chunk.type === "done" && chunk.finishReason) {
        state.lastFinishReason = chunk.finishReason;
      }
      if (chunk.type === "done" && chunk.usage) {
        // chat() вызывается ОДИН раз за итерацию — каждый `done` относится к тому
        // же запросу (usage-only + non-streaming fallback дают два done).
        // ЗАМЕНЯЕМ running-суммы, иначе один запрос посчитается дважды.
        tokenTracker.recordApiUsage(state, baseline, chunk.usage);
        if (chunk.usage.promptTokens > 0) {
          sawUsage = true;
          contextManager.calibrate?.(chunk.usage.promptTokens, estimateAtSend, messageCountAtSend);
        }
      }
      if (chunk.type === "warning" && chunk.content) {
        // Нефатальное уведомление провайдера (напр., ответ срезан cap'ом).
        logger.diagnostic("warn", `LLM warning: ${chunk.content}`);
        onChunk?.(`\n\n> ⚠️ ${chunk.content}\n`);
      }
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (host.isShutdownRequested() || e?.name === "AbortError") {
      logger.diagnostic("info", "LLM call aborted (interrupt)");
      return { kind: "break" };
    }
    // Реактивная компакция: context-length ошибка — один раз уплотняем и повторяем.
    if (
      err instanceof LlmError &&
      err.recoverable &&
      err.kind === "context_length" &&
      !state.reactiveCompactionUsed
    ) {
      state.reactiveCompactionUsed = true;
      state.iterRecoverableLlmError = true;
      state.lastCompactionIteration = state.iteration; // общий клок компакции (W4)
      const reactive = contextManager.compactAdaptive?.({
        toolResultKeep: contextManager.getToolResultKeep?.() ?? 6,
        minReduction: 0,
      });
      logger.diagnostic(
        "warn",
        `Context-length error — reactive compaction (reduced ${reactive?.reducedBy ?? 0} tokens)`,
      );
      if (reactive) {
        slog.logCompaction({
          reason: "reactive (context-length)",
          iteration: state.iteration,
          ...reactive,
        });
      }
      return { kind: "continue" };
    }
    // Восстановимые ошибки LLM (например, токен-лимит на середине tool_call):
    // отдаём локализованную причину обратно в контекст, чтобы модель
    // адаптировалась вместо смерти всей сессии. Ограничено во избежание цикла.
    if (
      err instanceof LlmError &&
      err.recoverable &&
      state.llmErrorRetries < MAX_LLM_ERROR_RETRIES
    ) {
      state.iterRecoverableLlmError = true;
      state.llmErrorRetries++;
      logger.diagnostic(
        "warn",
        `Recoverable LLM error, feeding back (${state.llmErrorRetries}/${MAX_LLM_ERROR_RETRIES}): ${err.message}`,
      );
      slog.logError({
        source: "core",
        operation: "llm.call",
        kind: "degraded",
        recoverable: true,
        cause: err.message,
      });
      pluginManager.runOnError({ iteration: state.iteration, logger, contextManager }, err);
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${err.message}</system-summary>`,
      });
      return { kind: "continue" };
    }
    const message = e?.message ?? String(err);
    logger.logLLMResponse(config.model, textContent.length, Date.now() - llmStart, message, "agent");
    logger.error(`LLM call failed: ${message}`);
    slog.logError({ source: "core", operation: "llm.call", kind: "failed", cause: message });
    pluginManager.runOnError(
      { iteration: state.iteration, logger, contextManager },
      err instanceof Error ? err : new Error(message),
    );
    return {
      kind: "return",
      result: {
        success: false,
        text: state.lastText,
        error: t("error.llm", { message }),
        iterationCount: state.iteration,
      },
    };
  } finally {
    host.emitPhase(state.iteration, "done", onPhase);
  }

  // Провайдер не отдал usage — калибровка помечается stale (>1 вызова).
  if (!sawUsage) contextManager.noteMissingUsage?.();

  // Совокупная длина ответа — метрики валидны, даже когда бэкенд опускает usage.
  tokenTracker.addCompletionChars(state, (textContent || reasoningContent).length);
  logger.logLLMResponse(
    config.model,
    (textContent || reasoningContent).length,
    Date.now() - llmStart,
    undefined,
    "agent",
  );
  state.totalLlmDuration += Date.now() - llmStart;

  // Per-call лог usage + стоимость (фолбэк на локальные оценки при отсутствии usage).
  tokenTracker.logUsage(
    state,
    baseline,
    textContent || reasoningContent,
    contextManager.getEstimatedTokens(),
    state.iteration,
    Date.now() - llmStart,
    slog,
  );

  if (host.isShutdownRequested()) return { kind: "break" };

  // Сообщаем модели, что аргументы тула были невалидным JSON: иначе она видит
  // лишь «пустой» вызов и не знает, что нужно повторить корректно.
  if (malformedToolArgs > 0) {
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${malformedToolArgs} tool call(s) in your last response had invalid JSON arguments and were executed with empty parameters. Re-issue them with valid JSON.</system-summary>`,
    });
  }

  let llmResponse: LLMResponse | null = null;
  if (sawToolCall) {
    llmResponse = { type: "tool_call", calls: toolCalls };
  } else if (textContent) {
    llmResponse = { type: "text", content: textContent };
  } else if (reasoningContent) {
    llmResponse = { type: "reasoning", content: reasoningContent };
  }
  pluginManager.runOnAfterThink({ iteration: state.iteration, logger, contextManager }, llmResponse);

  // Аннотация вывода модели в context-log (отдельным [OUTPUT]-блоком).
  if (deps.contextLogger && (reasoningContent || textContent || toolCalls.length > 0)) {
    try {
      deps.contextLogger.recordOutput({
        iteration: state.iteration,
        ts: new Date().toISOString(),
        reasoning: reasoningContent || undefined,
        text: textContent || undefined,
        toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
      });
    } catch {
      // Логирование контекста не должно ронять агент.
    }
  }

  // Детекция повторных одинаковых тулов (структурная). Сигнал питает reasoning
  // policy для понижения effort на рутине.
  if (sawToolCall) {
    const repeat = detectRepeatedToolCall(state, toolCalls, deps.exitOnComplete === true);
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

  return { kind: "ok", textContent, reasoningContent, toolCalls, sawToolCall };
}
