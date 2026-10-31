import { describe, it, expect } from "vitest";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";
import { fallbackPromptFacts } from "../../src/core/prompt-facts";
import { estimateTokens } from "../../src/llm/token-counter";

/** Детерминированный промпт для snapshot/бюджета: без security и с фиксированной датой. */
function fixedPrompt(): string {
  const config = structuredClone(DEFAULTS);
  config.security = { ...config.security, enabled: false };
  const facts = {
    ...fallbackPromptFacts(config, "/tmp/proj", "linux"),
    now: { iso: "2026-10-31 12:00:00 +00:00", timeZone: "UTC", utcOffset: "+00:00" },
    tools: { bun: "present" as const, git: "present" as const, python: "present" as const },
    project: {
      packageManager: "bun" as const,
      testCommand: "bun test",
      typecheckCommand: "tsc --noEmit",
      languages: [],
    },
  };
  return buildSystemInfo(config, "/tmp/proj", "linux", facts);
}

describe("system prompt: compact core", () => {
  it("fits the compact-core budget", () => {
    // Ядро без config-зависимого security: 896 токенов — цель 900 достигнута.
    expect(estimateTokens(fixedPrompt())).toBeLessThanOrEqual(900);
  });

  it("matches the golden snapshot", () => {
    expect(fixedPrompt()).toMatchSnapshot();
  });

  it("has no runtime line longer than 120 chars", () => {
    const long = fixedPrompt()
      .split("\n")
      .filter((line) => line.length > 120);
    expect(long).toEqual([]);
  });
});
