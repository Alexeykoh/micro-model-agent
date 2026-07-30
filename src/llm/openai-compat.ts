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
    const requestTimeoutMs = 60000;
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    const response = await this.fetchWithRetry(
      `${this.config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
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
    if (!reader) throw new Error(t("error.no_response_body"));

    const decoder = new TextDecoder();
    let buffer = "";
    let toolCallAccumulator: {
      id?: string;
      name?: string;
      arguments?: string;
    } = {};
    let lastChunkTime = Date.now();
    const inactivityTimeoutMs = 30000;
    const inactivityCheck = setInterval(() => {
      if (Date.now() - lastChunkTime > inactivityTimeoutMs) {
        controller.abort();
      }
    }, 5000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lastChunkTime = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield { type: "done", finishReason: "stop" };
            continue;
          }

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
                if (tc.id) toolCallAccumulator.id = tc.id;
                if (tc.function?.name)
                  toolCallAccumulator.name = tc.function.name;
                if (tc.function?.arguments) {
                  toolCallAccumulator.arguments =
                    (toolCallAccumulator.arguments || "") +
                    tc.function.arguments;
                }
              }
            }

            if (delta.content) {
              yield { type: "text", content: delta.content };
            }

            if (finishReason === "tool_calls" && toolCallAccumulator.name) {
              yield {
                type: "tool_call",
                toolCall: {
                  id: toolCallAccumulator.id || "",
                  name: toolCallAccumulator.name,
                  arguments: toolCallAccumulator.arguments || "{}",
                },
              };
              toolCallAccumulator = {};
            }

            if (finishReason === "stop") {
              yield { type: "done", finishReason: "stop" };
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      clearInterval(inactivityCheck);
      reader.releaseLock();
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
