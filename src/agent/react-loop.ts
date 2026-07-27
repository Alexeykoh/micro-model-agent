import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ContextManager } from './context.js';
import { doChat } from '../tools/subagent.js';
import { parseToolCalls } from '../tools/parse-tool-call.js';
import { logDebug, logInfo, logWarn } from '../logger.js';

/**
 * Минимальный общий ReAct-цикл для основного агента и субагента.
 *
 * Содержит только общие механики:
 * - while loop с step counting
 * - Инкрементальный подсчёт токенов
 * - Compaction контекста
 * - LLM-вызов
 * - Парсинг и валидация tool calls
 * - Пустые ответы
 *
 * Domain-логика (skills, plan enforcement, syntax check и т.д.)
 * передаётся через callbacks.
 *
 * @module agent/react-loop
 */

/** Конфигурация ReAct-цикла */
export interface ReactLoopConfig {
  provider: LLMProvider;
  systemPrompt: string;
  initialMessages?: ChatMessage[];
  maxSteps: number;
  quiet?: boolean;
  showThinking?: boolean;
  /** Имя вызывающего ('main' | 'subagent') */
  caller?: string;
}

/** Результат выполнения ReAct-цикла */
export interface ReactLoopResult {
  messages: ChatMessage[];
  response: string;
  steps: number;
  aborted: boolean;
}

/** Обработчики событий цикла */
export interface ReactLoopHandlers {
  /** Вызывается перед каждым шагом */
  onStepStart?: (step: number, messages: ChatMessage[]) => void | Promise<void>;
  /** Вызывается после LLM-ответа (до парсинга tool calls) */
  onAfterLLM?: (step: number, response: string) => string | void | Promise<string | void>;
  /** Вызывается для каждого tool call. Возвращает toolOutput + exitCode */
  onToolCall?: (
    step: number,
    parsed: Record<string, unknown>,
    cmd: string | undefined,
    isBash: boolean,
    toolId: string,
  ) => Promise<{ output: string; exitCode: number; breakLoop?: boolean }> | null;
  /** Вызывается после обработки всех tool calls на шаге */
  onStepEnd?: (step: number) => void | Promise<void>;
  /** Вызывается при compaction контекста */
  onCompact?: (before: number, after: number) => void;
  /** Вызывается при пустом ответе */
  onEmptyResponse?: (step: number, consecutiveEmpty: number) => void;
}

/**
 * Запуск минимального ReAct-цикла.
 *
 * @returns Результат с финальными messages и ответом
 */
export async function reactLoop(
  config: ReactLoopConfig,
  handlers: ReactLoopHandlers = {},
): Promise<ReactLoopResult> {
  const { provider, systemPrompt, initialMessages, maxSteps, quiet, showThinking, caller } = config;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(initialMessages || []),
  ];

  const ctx = new ContextManager(provider.contextWindow);
  let consecutiveEmpty = 0;
  let aborted = false;
  let lastResponse = '';

  for (let step = 0; step < maxSteps; step++) {
    // Step start
    await handlers.onStepStart?.(step, messages);

    // Token counting
    if (step === 0) {
      await ctx.updateTokens(messages);
    } else {
      await ctx.updateTokensIncremental(messages);
    }

    // Context compaction
    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      await ctx.updateTokens(messages);
      handlers.onCompact?.(before, messages.length);
    }

    // Emergency compact
    if (ctx.isOverflow) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.emergencyCompact(messages));
      await ctx.updateTokens(messages);
      handlers.onCompact?.(before, messages.length);
    }

    // LLM call
    const { response } = await doChat(
      provider, messages, null as any, undefined, 1, showThinking, caller as any
    );

    // Post-LLM hook (allows modification)
    const modifiedResponse = await handlers.onAfterLLM?.(step, response);
    const finalResponse = typeof modifiedResponse === 'string' ? modifiedResponse : response;

    // Empty response handling
    if (!finalResponse.trim()) {
      consecutiveEmpty++;
      handlers.onEmptyResponse?.(step, consecutiveEmpty);
      if (consecutiveEmpty >= 3) {
        logWarn(caller || 'REACT', `3 consecutive empty responses, stopping`);
        break;
      }
      messages.push({ role: 'assistant', content: finalResponse });
      messages.push({ role: 'user', content: 'Continue.' });
      continue;
    }

    consecutiveEmpty = 0;
    lastResponse = finalResponse;
    messages.push({ role: 'assistant', content: finalResponse });

    const { validCalls } = parseToolCalls(finalResponse);

    // No tool calls — done
    if (validCalls.length === 0) {
      logDebug(caller || 'REACT', `no valid tool calls at step ${step}, done`);
      break;
    }

    // Process tool calls
    let shouldBreak = false;
    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === 'bash';
      const toolId = `${caller || 'react'}-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;

      const result = await handlers.onToolCall?.(step, parsed, cmd, isBash, toolId);
      if (result) {
        messages.push({
          role: 'tool',
          content: result.output.slice(0, 8000),
          tool_call_id: toolId,
        });
        if (result.breakLoop) {
          shouldBreak = true;
          break;
        }
      }
    }

    if (shouldBreak) break;

    await handlers.onStepEnd?.(step);
  }

  return {
    messages,
    response: lastResponse,
    steps: messages.filter(m => m.role === 'assistant').length,
    aborted,
  };
}
