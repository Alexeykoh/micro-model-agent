import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolvePromptOverflow } from "../../src/core/prompt-overflow-resolve";
import { estimateTokens } from "../../src/llm/token-counter";
import type { PromptBlock } from "../../src/core/types";
import { recordingProvider } from "../helpers/recording-provider";

function block(content: string, estimatedTokens: number): PromptBlock {
  return { content, priority: "high", essential: false, estimatedTokens, kind: "instructions" };
}

describe("overflow resolution correctness (B8/B9/B10)", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mma-overflow-correct-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("B8: truncates cyrillic content within budget (no 1.6x overshoot)", async () => {
    const content = "Инструкция по запуску проекта: собери, проверь, задеплой. ".repeat(300);
    const estimated = estimateTokens(content);
    expect(estimated).toBeGreaterThan(2000);
    const res = await resolvePromptOverflow({
      overflow: [block(content, estimated)],
      includedTokens: 1000,
      systemBudget: 2000,
      provider: null,
      cacheDir,
      model: "m",
    });
    expect(res.warnings[0].mode).toBe("truncate");
    // maxTokens = 2000 - 1000 - 60 = 940: итог обязан влезть, а не висеть на ~1500.
    expect(res.replacements[0].estimatedTokens).toBeLessThanOrEqual(940);
  });

  it("B9: does not reuse another model's summary", async () => {
    const provider = recordingProvider(() => "SUMMARY TEXT");
    const opts = {
      overflow: [block("LONG".repeat(1000), 3000)],
      includedTokens: 1500,
      systemBudget: 3276,
      cacheDir,
    };
    await resolvePromptOverflow({ ...opts, provider, model: "m1" });
    expect(provider.calls.length).toBe(1);
    await resolvePromptOverflow({ ...opts, provider, model: "m2" });
    expect(provider.calls.length).toBe(2);
  });

  it("B9: reuses the same model's summary under a changed budget without an LLM call", async () => {
    const provider = recordingProvider(() => "SHORT");
    const overflow = [block("LONG".repeat(1000), 3000)];
    await resolvePromptOverflow({
      overflow,
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
      model: "m1",
    });
    expect(provider.calls.length).toBe(1);
    // Бюджет ужался, но выжимка влезает — sibling-hit, а не новая суммаризация.
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 1600,
      systemBudget: 3276,
      provider,
      cacheDir,
      model: "m1",
    });
    expect(provider.calls.length).toBe(1);
    expect(res.replacements[0].content).toContain("SHORT");
  });

  it("B10: caps the generation request within a small context window", async () => {
    const provider = recordingProvider(() => "SUMMARY TEXT");
    const content = "DATA ".repeat(4000); // ~3200 tok входа
    await resolvePromptOverflow({
      overflow: [block(content, estimateTokens(content))],
      includedTokens: 500,
      systemBudget: 3000,
      provider,
      cacheDir,
      model: "m1",
      contextWindow: 2000,
    });
    expect(provider.calls.length).toBeGreaterThan(0);
    const requested = provider.calls[0].options?.maxTokens ?? 0;
    // Старый код просил бы maxTokens*2 = 2*(3000-500-60) = 4880 при окне 2000.
    expect(requested).toBeLessThanOrEqual(2000);
  });

  it("B10: keeps the 2x headroom when no window is known", async () => {
    const provider = recordingProvider(() => "SUMMARY TEXT");
    await resolvePromptOverflow({
      overflow: [block("LONG".repeat(1000), 3000)],
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
      model: "m1",
    });
    const requested = provider.calls[0].options?.maxTokens ?? 0;
    expect(requested).toBe((3276 - 1500 - 60) * 2);
  });
});
