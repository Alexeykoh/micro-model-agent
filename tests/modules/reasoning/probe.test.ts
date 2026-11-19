import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Chunk } from "../../../src/llm/provider";
import { recordingProvider } from "../../helpers/recording-provider";
import {
  probeReasoningSupport,
  cacheKey,
  getCachedProbeResult,
  setCachedProbeResult,
  resetProbeCache,
  probeCacheTtlMs,
} from "../../../src/modules/reasoning/probe";

/**
 * D2: проба меряет ДВА ординала — при «выключено» reasoning-чанков быть не
 * должно, при «высоко» — должны появиться. Провайдер здесь уровне-зависимый:
 * иначе «выключено» неотличимо от «модель молчит».
 */
function makeProvider(off: Chunk[] | "throw", on: Chunk[] | "throw") {
  return recordingProvider((call) => {
    const which = call.options?.reasoningEffort === "none" ? off : on;
    if (which === "throw") throw new Error("network down");
    return which;
  });
}

describe("probeReasoningSupport", () => {
  beforeEach(() => {
    resetProbeCache();
  });
  afterEach(() => {
    resetProbeCache();
  });

  it("confirms when off suppresses and on produces reasoning", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }], [{ type: "reasoning", content: "thinking" }]);
    expect(await probeReasoningSupport(provider, "prompt-tag")).toBe(true);
  });

  it("does not confirm when reasoning appears despite off", async () => {
    const provider = makeProvider(
      [{ type: "reasoning", content: "thinking" }],
      [{ type: "reasoning", content: "thinking" }],
    );
    expect(await probeReasoningSupport(provider, "prompt-tag")).toBe(false);
  });

  it("does not confirm when the mechanism is inert (nothing reasons even at high)", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }], [{ type: "text", content: "ok" }]);
    expect(await probeReasoningSupport(provider, "prompt-tag")).toBe(false);
  });

  it("returns null on transient error instead of false", async () => {
    const provider = makeProvider("throw", [{ type: "reasoning", content: "x" }]);
    expect(await probeReasoningSupport(provider, "prompt-tag")).toBeNull();
  });

  it("does not cache a null probe result", async () => {
    const provider = makeProvider("throw", [{ type: "reasoning", content: "x" }]);
    const key = cacheKey("http://x", "m");
    const passed = await probeReasoningSupport(provider, "prompt-tag");
    if (passed !== null) setCachedProbeResult(key, passed);
    expect(getCachedProbeResult(key)).toBeUndefined();
  });

  it("caches a definitive result for later reads", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }], [{ type: "reasoning", content: "x" }]);
    const key = cacheKey("http://x", "m");
    const passed = await probeReasoningSupport(provider, "prompt-tag");
    expect(passed).toBe(true);
    setCachedProbeResult(key, passed as boolean);
    expect(getCachedProbeResult(key)).toBe(true);
  });

  it("treats strategy 'none' as unsupported without probing", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }], [{ type: "text", content: "ok" }]);
    expect(await probeReasoningSupport(provider, "none")).toBe(false);
    expect(provider.calls.length).toBe(0);
  });

  it("treats 'openai-effort' without an advertised off-switch as supported without probing", async () => {
    const provider = makeProvider("throw", "throw");
    expect(await probeReasoningSupport(provider, "openai-effort", false)).toBe(true);
    expect(provider.calls.length).toBe(0);
  });

  it("probes 'openai-effort' when the endpoint advertises an off-switch (D2)", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }], [{ type: "reasoning", content: "x" }]);
    expect(await probeReasoningSupport(provider, "openai-effort", true)).toBe(true);
    // Оба ординала отправлены (off + high).
    expect(provider.calls.length).toBe(2);
  });

  it("uses a reasoning-inducing prompt instead of the trivial one (INV-R6)", async () => {
    const provider = makeProvider([{ type: "text", content: "ok" }], [{ type: "reasoning", content: "x" }]);
    await probeReasoningSupport(provider, "prompt-tag");
    const prompt = provider.calls[0]?.messages[0]?.content;
    expect(prompt).not.toBe("Reply with exactly: ok");
    expect(String(prompt)).toContain("17 * 23");
  });

  it("scopes the cache to strategy and off-switch, not just baseUrl|model", () => {
    const tagNoOff = cacheKey("http://x", "m", "prompt-tag", false);
    const effortOff = cacheKey("http://x", "m", "openai-effort", true);
    expect(tagNoOff).not.toBe(effortOff);

    setCachedProbeResult(tagNoOff, false);
    expect(getCachedProbeResult(tagNoOff)).toBe(false);
    // Вердикт одной механики не течёт в другую.
    expect(getCachedProbeResult(effortOff)).toBeUndefined();
  });

  it("keeps a negative verdict on a shorter TTL than a positive one", () => {
    expect(probeCacheTtlMs(false)).toBeLessThan(probeCacheTtlMs(true));
  });
});
