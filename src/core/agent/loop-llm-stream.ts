/**
 * Потребление стрима провайдера в фазе LLM: накопление text/reasoning/tool_call,
 * разбор аргументов тулов, usage-сигналы `done` и предупреждения провайдера.
 *
 * Вынесено из `loop-llm.ts` (правило 6: файл на потолке `.arch-allowlist.json`):
 * цикл по чанкам — отдельный шов, наружу отдаётся только накопленный результат.
 */
import type { AgentDeps } from "../agent";
import type { ReasoningLevel } from "../../config/types";
import type { SessionLogger } from "../session-logger";
import type { ToolCall, ToolDefinition } from "../../tools/types";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";

/** Снимок running-сумм до запроса — вход замены usage-цифр. */
export interface LlmUsageBaseline {
  promptBefore: number;
  completionBefore: number;
  costBefore?: number;
}

/** Что собрано из стрима одного вызова LLM. */
export interface LlmStreamResult {
  textContent: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  sawToolCall: boolean;
  sawUsage: boolean;
  malformedToolArgs: number;
  /** Момент первого контентного чанка — от него меряем decode (без префилла/TTFT). */
  firstTokenAt: number;
}

/** Пустой аккумулятор стрима (мутируется по мере чанков). */
export function createLlmStreamResult(): LlmStreamResult {
  return {
    textContent: "",
    reasoningContent: "",
    toolCalls: [],
    sawToolCall: false,
    sawUsage: false,
    malformedToolArgs: 0,
    firstTokenAt: 0,
  };
}

/** Входные данные цикла по чанкам. */
export interface LlmStreamInput {
  deps: AgentDeps;
  state: LoopState;
  slog: SessionLogger;
  tokenTracker: TokenTracker;
  baseline: LlmUsageBaseline;
  estimateAtSend: number;
  messageCountAtSend: number;
  history: ReturnType<AgentDeps["contextManager"]["getActiveHistory"]>;
  tools: ToolDefinition[];
  /** Уровень reasoning от резолвера; undefined = механизм не применяется. */
  reasoningLevel?: ReasoningLevel;
  maxTokensOverride?: number;
  isShutdownRequested(): boolean;
  getAbortSignal(): AbortSignal | undefined;
  onChunk?: (chunk: string) => void;
  onReasoning?: (reasoning: string) => void;
}

/**
 * Читает стрим до конца (или до запроса на остановку), наполняя `out`.
 * Аккумулятор передаётся снаружи: при обрыве по ошибке частичный текст
 * остаётся виден вызывающему (для лога длины ответа).
 */
export async function consumeLlmStream(
  inp: LlmStreamInput,
  out: LlmStreamResult,
): Promise<LlmStreamResult> {
  const { deps, state, slog, tokenTracker, baseline } = inp;
  const { contextManager, pluginManager, logger, llmProvider, config } = deps;
  const { onChunk, onReasoning } = inp;
  let emittedReasoning = false;

  for await (const chunk of llmProvider.chat(inp.history, inp.tools, inp.getAbortSignal(), {
    ...(inp.reasoningLevel ? { reasoningEffort: inp.reasoningLevel } : {}),
    ...(inp.maxTokensOverride !== undefined ? { maxTokens: inp.maxTokensOverride } : {}),
    sessionId: deps.sessionManager?.getActiveMeta()?.id,
  })) {
    if (inp.isShutdownRequested()) break;
    if (chunk.type === "text" && chunk.content) {
      if (!out.firstTokenAt) out.firstTokenAt = Date.now();
      if (emittedReasoning && !out.textContent) {
        onReasoning?.("\n\n");
      }
      out.textContent += chunk.content;
      const textOut = pluginManager.runOnText(
        { iteration: state.iteration, logger, contextManager },
        chunk.content,
      );
      onChunk?.(textOut);
    }
    if (chunk.type === "reasoning" && chunk.content) {
      if (!out.firstTokenAt) out.firstTokenAt = Date.now();
      out.reasoningContent += chunk.content;
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
      if (!out.firstTokenAt) out.firstTokenAt = Date.now();
      out.sawToolCall = true;
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(chunk.toolCall.arguments);
      } catch {
        // Битый JSON аргументов раньше молча превращался в `{}` — модель звала
        // тул с пустыми параметрами и не понимала причины. Логируем и сообщаем.
        parsedArgs = {};
        out.malformedToolArgs++;
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
      out.toolCalls.push({
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
        out.sawUsage = true;
        contextManager.calibrate?.(
          chunk.usage.promptTokens,
          inp.estimateAtSend,
          inp.messageCountAtSend,
        );
      }
    }
    if (chunk.type === "warning" && chunk.content) {
      // Нефатальное уведомление провайдера (напр., ответ срезан cap'ом).
      logger.diagnostic("warn", `LLM warning: ${chunk.content}`);
      onChunk?.(`\n\n> ⚠️ ${chunk.content}\n`);
    }
  }

  return out;
}
