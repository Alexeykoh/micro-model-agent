// src/modules/reasoning/probe.ts
import type { LLMProvider, Message } from "../../llm/provider";
import type { ReasoningStrategy } from "../../config/types";

const PROBE_MESSAGES: Message[] = [
  { role: "user", content: "Reply with exactly: ok" },
];

/**
 * Probe whether the backend actually respects the reasoning effort mechanism.
 * Sends a trivial non-streaming request with level forced to "none" via the
 * mapped strategy. If reasoning_content still appears, the mechanism is ignored.
 */
export async function probeReasoningSupport(
  provider: LLMProvider,
  strategy: ReasoningStrategy,
  signal?: AbortSignal,
): Promise<boolean> {
  if (strategy === "none") return false;

  try {
    let hasReasoning = false;
    for await (const chunk of provider.chat(PROBE_MESSAGES, undefined, signal, {
      maxTokens: 32,
      reasoningEffort: "none",
      reasoningStrategy: strategy,
    })) {
      if (chunk.type === "reasoning") hasReasoning = true;
    }
    // If reasoning content appeared despite "none", the mechanism is ignored
    return !hasReasoning;
  } catch {
    return false;
  }
}

/** Cache keyed by "baseUrl|model". */
const probeCache = new Map<string, boolean>();

export function cacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

export function getCachedProbeResult(key: string): boolean | undefined {
  return probeCache.get(key);
}

export function setCachedProbeResult(key: string, result: boolean): void {
  probeCache.set(key, result);
}

export function resetProbeCache(): void {
  probeCache.clear();
}
