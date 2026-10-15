import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  dryRunOverflow,
  resolvePromptOverflow,
  resolveContextWindowSource,
  contextWindowHint,
  recommendContextSize,
  requiredContextWindow,
  requiredSystemFraction,
  overflowHint,
  HINT_BLOCK_TOKENS,
} from "../../src/core/prompt-overflow";
import type { PromptBlock } from "../../src/core/types";
import type { Chunk, LLMProvider } from "../../src/llm/provider";
import { recordingProvider, type RecordingProvider } from "../helpers/recording-provider";
import { setLocale } from "../../src/i18n/index";

interface CapturingLogger {
  warns: string[];
  warn(msg: string): void;
  info(): void;
  debug(): void;
  error(): void;
}

function capturingLogger(): CapturingLogger {
  const warns: string[] = [];
  return { warns, warn: (m: string) => warns.push(m), info: () => {}, debug: () => {}, error: () => {} };
}

function block(partial: Partial<PromptBlock> & { content: string }): PromptBlock {
  return {
    priority: "high",
    essential: false,
    estimatedTokens: Math.ceil(partial.content.length / 4),
    ...partial,
  };
}

function fakeProvider(respond: () => string): RecordingProvider {
  return recordingProvider(() => respond());
}

describe("dryRunOverflow", () => {
  it("reports kind-carrying blocks that exceed the budget", () => {
    const base = block({ content: "base", priority: "critical", essential: true });
    const big = block({ content: "X".repeat(4000), kind: "instructions", estimatedTokens: 3000 });
    const small = block({ content: "small hint", estimatedTokens: 10 });
    const dry = dryRunOverflow([base, big, small], 400);
    expect(dry.overflow).toHaveLength(1);
    expect(dry.overflow[0].kind).toBe("instructions");
    expect(dry.includedTokens).toBeGreaterThan(0);
  });

  it("ignores excluded blocks without a kind", () => {
    const base = block({ content: "base", priority: "critical", essential: true });
    const big = block({ content: "Y".repeat(4000), estimatedTokens: 500 });
    const dry = dryRunOverflow([base, big], 400);
    expect(dry.overflow).toHaveLength(0);
  });
});

describe("budget requirement helpers", () => {
  it("computes the window needed for a system-token requirement", () => {
    expect(requiredContextWindow(9079, 0.1)).toBe(90790);
    expect(requiredContextWindow(3200, 0.2)).toBe(16000);
  });

  it("computes the share needed at a given window", () => {
    expect(requiredSystemFraction(9079, 32000)).toBe(0.29);
    expect(requiredSystemFraction(100, 32000)).toBe(0.01);
    expect(requiredSystemFraction(40000, 32000)).toBe(1);
  });

  it("states the raw need and both levers in the hint", () => {
    setLocale("en");
    const config = {
      contextWindow: 32000,
      contextBudget: { systemPrompt: 0.1, responseReserve: 0.15, compactionThreshold: 0.75 },
      provider: {},
    } as any;
    const hint = overflowHint(config, undefined, 9079);
    expect(hint).toContain("9079");
    expect(hint).toContain("90790");
    expect(hint).toContain("131072");
    expect(hint).toContain("contextBudget.systemPrompt");
  });
});

describe("resolvePromptOverflow", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "mma-prompt-overflow-"));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("summarizes with the provider and preserves the kind", async () => {
    const provider = fakeProvider(() => "SUMMARY: keep rules A, B, C");
    const overflow = [block({ content: "LONG".repeat(1000), kind: "instructions", estimatedTokens: 3000 })];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    expect(res.replacements).toHaveLength(1);
    expect(res.replacements[0].kind).toBe("instructions");
    expect(res.replacements[0].content).toContain("SUMMARY");
    // Replacement must fit the remaining budget (3276 - 1500 - hint)
    expect(res.replacements[0].estimatedTokens).toBeLessThanOrEqual(3276 - 1500);
    expect(res.warnings[0].mode).toBe("summary");
    expect(res.hintBlock?.essential).toBe(true);
    expect(res.hintBlock?.content).toContain("AGENTS.md");
  });

  it("disables reasoning at the level, leaving the mechanism to the provider (INV-R1)", async () => {
    const captured: Array<{ reasoningEffort?: string; reasoningStrategy?: unknown }> = [];
    const provider = {
      model: "fake",
      contextWindow: 32768,
      countTokens: (text: string) => Math.ceil(text.length / 4),
      listModels: async () => [],
      // @ts-expect-error — test stub narrows the streaming API
      chat: async function* (
        _messages: unknown,
        _tools: unknown,
        _signal: unknown,
        options?: { reasoningEffort?: string; reasoningStrategy?: unknown },
      ) {
        if (options) captured.push(options);
        yield { type: "text", content: "SUMMARY: rules" } as Chunk;
      },
    } as unknown as LLMProvider;
    await resolvePromptOverflow({
      overflow: [block({ content: "LONG".repeat(1000), kind: "instructions", estimatedTokens: 3000 })],
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].reasoningEffort).toBe("none");
    // Механизм — свойство экземпляра провайдера; call-site его не знает и не
    // передаёт, иначе забывчивость молча вернула бы дефолт (INV-R1).
    expect(captured[0].reasoningStrategy).toBeUndefined();
  });

  it("falls back to truncation when the provider fails", async () => {
    const provider = fakeProvider(() => {
      throw new Error("backend down");
    });
    const overflow = [block({ content: "DATA".repeat(6000), kind: "instructions", estimatedTokens: 3000 })];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 1000,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    expect(res.warnings[0].mode).toBe("truncate");
    expect(res.replacements[0].content).toContain("truncated");
    expect(res.replacements[0].estimatedTokens).toBeLessThanOrEqual(3276 - 1000);
  });

  it("notifies when compression starts and before summarizing", async () => {
    setLocale("en");
    const logger = capturingLogger();
    const provider = fakeProvider(() => "SUMMARY: keep rules");
    await resolvePromptOverflow({
      overflow: [block({ content: "LONG".repeat(1000), kind: "instructions", estimatedTokens: 3000 })],
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
      logger: logger as unknown as Parameters<typeof resolvePromptOverflow>[0]["logger"],
    });
    expect(logger.warns.some((m) => m.includes("compressing"))).toBe(true);
    expect(logger.warns.some((m) => m.includes("summarizing"))).toBe(true);
  });

  it("notifies on truncation fallback", async () => {
    setLocale("en");
    const logger = capturingLogger();
    const provider = fakeProvider(() => {
      throw new Error("backend down");
    });
    await resolvePromptOverflow({
      overflow: [block({ content: "DATA".repeat(6000), kind: "instructions", estimatedTokens: 3000 })],
      includedTokens: 1000,
      systemBudget: 3276,
      provider,
      cacheDir,
      logger: logger as unknown as Parameters<typeof resolvePromptOverflow>[0]["logger"],
    });
    expect(logger.warns.some((m) => m.includes("truncating"))).toBe(true);
  });

  it("truncates when no provider is available (summarize disabled)", async () => {
    const overflow = [block({ content: "DATA".repeat(2000), kind: "instructions", estimatedTokens: 3000 })];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 1000,
      systemBudget: 3276,
      provider: null,
      cacheDir,
    });
    expect(res.warnings[0].mode).toBe("truncate");
    expect(res.replacements[0].content).toContain("DATA");
  });

  it("retries self-compression when the summary overshoots and keeps summary mode", async () => {
    const long = "OVERSHOT ".repeat(900); // ~5000 chars → > maxTokens
    const short = "COMPRESSED: rules kept";
    let call = 0;
    const provider = fakeProvider(() => {
      call++;
      return call === 1 ? long : short;
    });
    const overflow = [block({ content: "LONG".repeat(1000), kind: "instructions", estimatedTokens: 3000 })];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    expect(call).toBe(2);
    expect(res.warnings[0].mode).toBe("summary");
    expect(res.replacements[0].content).toContain("COMPRESSED");
  });

  it("clamps to truncate when even the retry overshoots", async () => {
    const long = "OVERSHOT ".repeat(900);
    let call = 0;
    const provider = fakeProvider(() => {
      call++;
      return long;
    });
    const overflow = [block({ content: "LONG".repeat(1000), kind: "instructions", estimatedTokens: 3000 })];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 1500,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    expect(call).toBe(2);
    expect(res.warnings[0].mode).toBe("truncate");
    expect(res.replacements[0].estimatedTokens).toBeLessThanOrEqual(3276 - 1500);
  });

  it("caches the summary on disk and skips the provider on a second call", async () => {
    const provider = fakeProvider(() => "CACHED SUMMARY TEXT");
    const content = "LONG".repeat(1000);
    const overflow = [block({ content, kind: "instructions", estimatedTokens: 3000 })];
    const opts = {
      overflow,
      includedTokens: 1500,
      systemBudget: 3276,
      cacheDir,
    };
    await resolvePromptOverflow({ ...opts, provider });
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir).length).toBe(1);

    // Cache key depends on content — same content must hit without a call.
    const provider2 = fakeProvider(() => "SHOULD NOT BE CALLED");
    const res2 = await resolvePromptOverflow({ ...opts, provider: provider2 });
    expect(res2.warnings[0].mode).toBe("summary");
    expect(res2.replacements[0].content).toContain("CACHED SUMMARY TEXT");
    expect(provider2.calls.length).toBe(0);
  });

  it("resolves instructions before project-map and mentions unresolved blocks in the hint", async () => {
    const provider = fakeProvider(() => "S");
    const overflow = [
      block({ content: "MAP".repeat(500), kind: "project-map", estimatedTokens: 2000 }),
      block({ content: "AGENTS".repeat(500), kind: "instructions", estimatedTokens: 2000 }),
    ];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 2500,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    // Remaining budget: 3276 - 2500 - 60 (hint) = 716 → instructions first,
    // project-map gets ~nothing and must be listed as unresolved.
    expect(res.replacements[0].kind).toBe("instructions");
    expect(res.hintBlock?.content).toContain("project map");
  });

  it("allocates within budget so re-build includes the replacement", async () => {
    const provider = fakeProvider(() => "short summary");
    const overflow = [block({ content: "LONG".repeat(800), kind: "project-map", estimatedTokens: 1233 })];
    const res = await resolvePromptOverflow({
      overflow,
      includedTokens: 2100,
      systemBudget: 3276,
      provider,
      cacheDir,
    });
    const total = 2100 + res.replacements[0].estimatedTokens + HINT_BLOCK_TOKENS;
    expect(total).toBeLessThanOrEqual(3276);
  });
});

describe("resolveContextWindowSource / hints", () => {
  const baseConfig = (provider: any) =>
    ({ contextWindow: 32768, provider } as any);

  it("detects a global contextWindow", () => {
    const src = resolveContextWindowSource(baseConfig({ type: "openai-compat", baseUrl: "x" }));
    expect(src).toEqual({ source: "global", value: 32768 });
  });

  it("detects an entry override for the active label", () => {
    const src = resolveContextWindowSource(
      baseConfig({
        type: "openai-compat",
        baseUrl: "x",
        active: "lmstudio",
        entries: [
          { label: "lmstudio", baseUrl: "x", contextWindow: 65536 },
          { label: "other", baseUrl: "y" },
        ],
      }),
    );
    expect(src.source).toBe("entry");
    expect(src.label).toBe("lmstudio");
    expect(src.value).toBe(65536);
  });

  it("formats a global hint as an mma context command", () => {
    const hint = contextWindowHint(baseConfig({ type: "x", baseUrl: "x" }), "/cfg", 65536);
    expect(hint).toContain('mma context 65536');
  });

  it("formats an entry hint as a provider.json edit", () => {
    const hint = contextWindowHint(
      baseConfig({
        type: "x",
        baseUrl: "x",
        active: "lmstudio",
        entries: [{ label: "lmstudio", baseUrl: "x", contextWindow: 65536 }],
      }),
      join("home", ".mma"),
      65536,
    );
    expect(hint).toContain("provider.json");
    expect(hint).toContain("lmstudio");
    expect(hint).toContain("65536");
  });
});

describe("recommendContextSize", () => {
  it("returns a size whose system budget fits the needed tokens", () => {
    expect(recommendContextSize(3000)).toBe(32768);
    expect(recommendContextSize(5300)).toBe(65536);
    expect(recommendContextSize(100)).toBe(8192);
  });
});
