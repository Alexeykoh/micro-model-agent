// Guard: DLP-обёртка не теряет getSessionId. Иначе после bootstrap (egress
// guard установлен глобально) эксперт/критик уходят в OpenCode без
// `x-opencode-session` и получают 400 MissingSessionID.
import { describe, it, expect } from "vitest";
import { SanitizingProvider } from "../../src/modules/providers/sanitizing";
import type { LLMProvider } from "../../src/llm/provider";

function inner(getSessionId?: () => string | undefined): LLMProvider {
  return {
    model: "m",
    contextWindow: 1000,
    countTokens: () => 1,
    listModels: async () => [],
    chat: async function* () {},
    getSessionId,
  } as unknown as LLMProvider;
}

const guard = {
  target: { kind: "remote", trusted: false },
  sanitizeChat: (messages: unknown[]) => ({ messages, changed: false }),
  rehydrateArgs: (s: string) => s,
};

describe("SanitizingProvider: getSessionId", () => {
  it("пробрасывает геттер сессии", () => {
    const p = new SanitizingProvider(inner(() => "ses_x"), guard);
    expect(p.getSessionId?.()).toBe("ses_x");
  });

  it("не выдумывает геттер, если у inner его нет", () => {
    const p = new SanitizingProvider(inner(undefined), guard);
    expect(p.getSessionId).toBeUndefined();
  });
});
