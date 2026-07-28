import type { LLMProvider, ChatMessage, ChatOptions, Chunk } from './provider.js';
import { getLLMConfig } from '../config/config.js';

/**
 * LM Studio native API provider (/api/v1/chat).
 *
 * Uses the native LM Studio API instead of OpenAI-compatible endpoint.
 * Key advantage: reasoning: "off" actually disables thinking,
 * solving the empty response problem with reasoning models.
 *
 * @module llm/lmstudio-native
 */

interface LMStudioError {
  error?: { message?: string; type?: string; code?: string; param?: string };
}

interface StreamEvent {
  type: string;
  content?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  error?: LMStudioError['error'];
  result?: {
    output: Array<{ type: string; content?: string; tool?: string; arguments?: Record<string, unknown>; output?: string }>;
    stats: {
      input_tokens: number;
      total_output_tokens: number;
      reasoning_output_tokens: number;
      tokens_per_second: number;
      time_to_first_token_seconds: number;
    };
  };
}

/** Models that support reasoning/thinking */
const REASONING_MODEL_PATTERNS = [
  /qwen.*3\.5/i,
  /qwen.*3.*thinking/i,
  /deepseek.*r1/i,
  /deepseek.*reason/i,
];

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PATTERNS.some(p => p.test(model));
}

export class LMStudioNative implements LLMProvider {
  readonly model: string;
  contextWindow: number;
  private baseUrl: string;

  constructor(baseUrl: string, model: string, contextWindow: number) {
    // Native API is at /api/v1/chat, not /v1/chat/completions
    // Strip /v1 suffix if present since native API uses /api/v1
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.model = model;
    this.contextWindow = contextWindow;
  }

  async *chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<Chunk> {
    const reasoning = isReasoningModel(this.model);
    const llmCfg = getLLMConfig();
    const defaultMaxTokens = reasoning ? llmCfg.maxTokensReasoning : llmCfg.maxTokensDefault;

    // Convert messages to a single text block for native API
    // Native API doesn't support role-based messages, so we format as:
    // [System] content\n[User] content\n[Assistant] content\n...
    // This preserves conversation history while using reasoning: "off"
    const inputLines: string[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        inputLines.push(`[System] ${m.content}`);
      } else if (m.role === 'user') {
        inputLines.push(`[User] ${m.content}`);
      } else if (m.role === 'assistant') {
        inputLines.push(`[Assistant] ${m.content}`);
      } else if (m.role === 'tool') {
        inputLines.push(`[Tool result] ${m.content}`);
      }
    }
    const input = inputLines.join('\n');

    // Determine reasoning setting
    // When enableThinking is explicitly set, use it; otherwise use "off" for reasoning models
    // to prevent empty response issues
    let reasoningSetting: 'off' | 'on' = 'off';
    if (options?.enableThinking) {
      reasoningSetting = 'on';
    }

    const body: Record<string, unknown> = {
      model: this.model,
      input,
      stream: true,
      temperature: options?.temperature ?? 0.3,
      max_output_tokens: options?.max_tokens ?? defaultMaxTokens,
      reasoning: reasoningSetting,
    };

    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.stop !== undefined) body.stop = options.stop;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const response = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const err: LMStudioError = await response.json().catch(() => ({}));
      throw new Error(`LM Studio API ${response.status}: ${err.error?.message ?? response.statusText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool calls being accumulated
    const pendingToolCalls: Map<string, { name: string; arguments: string }> = new Map();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events: "event: <type>\ndata: <json>\n\n"
      const eventBlocks = buffer.split('\n\n');
      buffer = eventBlocks.pop() ?? '';

      for (const block of eventBlocks) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        let eventType = '';
        let jsonData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            jsonData = line.slice(6);
          }
        }

        if (!eventType || !jsonData) continue;

        try {
          const event: StreamEvent = JSON.parse(jsonData);

          switch (eventType) {
            case 'reasoning.delta':
              // Reasoning content — yield as reasoning chunk
              if (event.content) {
                yield { content: '', reasoning: event.content, finish_reason: null };
              }
              break;

            case 'message.delta':
              // Message content — yield as content chunk
              if (event.content) {
                yield { content: event.content, reasoning: undefined, finish_reason: null };
              }
              break;

            case 'tool_call.start':
              // New tool call starting
              if (event.tool) {
                pendingToolCalls.set(event.tool, { name: event.tool, arguments: '' });
              }
              break;

            case 'tool_call.arguments':
              // Tool call arguments arriving
              if (event.tool && event.arguments) {
                const existing = pendingToolCalls.get(event.tool);
                if (existing) {
                  existing.arguments = JSON.stringify(event.arguments);
                }
              }
              break;

            case 'tool_call.success':
              // Tool call completed — convert to <tool_call> text format
              if (event.tool) {
                const tc = pendingToolCalls.get(event.tool) ?? { name: event.tool, arguments: '{}' };
                const toolCallText = `<tool_call>{"name":"${tc.name}","arguments":${tc.arguments || '{}'}}</tool_call>`;
                yield { content: toolCallText, reasoning: undefined, finish_reason: 'tool_calls' };
                pendingToolCalls.delete(event.tool);
              }
              break;

            case 'chat.end':
              // Final event — check if there were tool calls in the result
              if (event.result?.output) {
                for (const item of event.result.output) {
                  if (item.type === 'tool_call' && item.tool) {
                    const argsStr = item.arguments ? JSON.stringify(item.arguments) : '{}';
                    const toolCallText = `<tool_call>{"name":"${item.tool}","arguments":${argsStr}}</tool_call>`;
                    yield { content: toolCallText, reasoning: undefined, finish_reason: 'tool_calls' };
                  }
                }
              }
              // Yield final finish_reason
              yield { content: '', reasoning: undefined, finish_reason: 'stop' };
              break;

            case 'error':
              if (event.error) {
                throw new Error(`LM Studio error: ${event.error.message}`);
              }
              break;
          }
        } catch (e: any) {
          if (e.message?.startsWith('LM Studio error:')) throw e;
          // Skip malformed events
        }
      }
    }
  }

  async countTokens(text: string): Promise<number> {
    const mod = await import('./token-counter.js');
    return mod.countTokens(text);
  }
}
