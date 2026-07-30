import type { LLMProvider, Message, Chunk, ToolDefinition } from "./provider";
import { TokenCounter } from "./token-counter";
import { t } from "../i18n/index";

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

export interface OpenAICompatConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  retry?: RetryConfig;
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly model: string;
  readonly contextWindow: number;
  private config: OpenAICompatConfig;
  private tokenCounter: TokenCounter;
  private retryConfig: RetryConfig;

  constructor(config: OpenAICompatConfig) {
    this.config = config;
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 32768;
    this.tokenCounter = new TokenCounter();
    this.retryConfig = config.retry ?? {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
    };
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncIterable<Chunk> {
    const streamResult = this.doStream(messages, tools);

    let hasToolCall = false;
    let hasText = false;
    let reasoningAcc = "";

    for await (const chunk of streamResult) {
      if (chunk.type === "tool_call") hasToolCall = true;
      if (chunk.type === "text") hasText = true;
      if (chunk.type === "reasoning" && chunk.content) {
        reasoningAcc += chunk.content;
      }
      yield chunk;
    }

    if (!hasToolCall && !hasText) {
      const fallback = await this.doNonStreaming(messages, tools);
      for (const chunk of fallback) {
        yield chunk;
      }
    }
  }

  private async *doStream(
    messages: Message[],
    tools?: ToolDefinition[],
  ): AsyncIterable<Chunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: this.config.maxCompletionTokens ?? 4096,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey && this.config.apiKey !== "not-needed") {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const totalTimeoutMs = 120000;
    const timeoutId = setTimeout(() => controller.abort(), totalTimeoutMs);

    const response = await this.fetchWithRetry(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorText = await response.text();
      throw new Error(
        t("error.llm_api", {
          status: response.status,
          statusText: response.statusText,
          errorText,
        }),
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      clearTimeout(timeoutId);
      throw new Error(t("error.no_response_body"));
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallAccs = new Map<number, ToolCallAcc>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta || {};
            const finishReason = choice.finish_reason;

            if (delta.reasoning_content) {
              yield { type: "reasoning", content: delta.reasoning_content };
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallAccs.has(idx)) {
                  toolCallAccs.set(idx, { id: "", name: "", arguments: "" });
                }
                const acc = toolCallAccs.get(idx)!;
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                  acc.arguments += tc.function.arguments;
                }
              }
            }

            if (delta.content) {
              yield { type: "text", content: delta.content };
            }

            if (finishReason === "tool_calls" && toolCallAccs.size > 0) {
              for (const [, acc] of toolCallAccs) {
                if (acc.name) {
                  yield {
                    type: "tool_call",
                    toolCall: {
                      id: acc.id,
                      name: acc.name,
                      arguments: acc.arguments || "{}",
                    },
                  };
                }
              }
              toolCallAccs.clear();
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }
  }

  private async doNonStreaming(
    messages: Message[],
    tools?: ToolDefinition[],
  ): Promise<Chunk[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      max_tokens: this.config.maxCompletionTokens ?? 4096,
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = "auto";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey && this.config.apiKey !== "not-needed") {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    try {
      const response = await this.fetchWithRetry(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          "[doNonStreaming] HTTP error:",
          response.status,
          errorText.slice(0, 500),
        );
        return [];
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) {
        console.error("[doNonStreaming] No choices in response");
        return [];
      }

      const msg = choice.message || {};
      const chunks: Chunk[] = [];

      if (msg.reasoning_content) {
        chunks.push({ type: "reasoning", content: msg.reasoning_content });
      }
      if (msg.content) {
        chunks.push({ type: "text", content: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chunks.push({
            type: "tool_call",
            toolCall: {
              id: tc.id || "",
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "{}",
            },
          });
        }
      }

      console.error(
        "[doNonStreaming] chunks:",
        chunks.length,
        "tool_calls:",
        msg.tool_calls?.length,
        "content len:",
        msg.content?.length,
      );
      if (chunks.length === 0) {
        console.error(
          "[doNonStreaming] Empty response: no content, no tool_calls, no reasoning",
        );
      }
      return chunks;
    } catch (err) {
      console.error(
        "[doNonStreaming] Fetch error:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  countTokens(text: string): number {
    return this.tokenCounter.count(text);
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const { maxRetries, baseDelay, maxDelay } = this.retryConfig;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (!this.isRetryable(response.status)) return response;
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw err;
        }
        lastError = err;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        const jitter = Math.random() * baseDelay * 0.1;
        await this.sleep(delay + jitter);
      }
    }

    throw lastError ?? new Error(t("error.llm_retries"));
  }

  private isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
