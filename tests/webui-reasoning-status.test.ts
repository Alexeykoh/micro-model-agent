import { describe, it, expect } from "vitest";
import { reasoningStatus } from "../src/modules/webui/assets/js/settings/reasoning-status";

describe("reasoningStatus (INV-R7)", () => {
  it("does not assert that the backend ignores effort when the probe failed", () => {
    const status = reasoningStatus({ strategy: "openai-effort", supported: false });
    expect(status.noteKey).toBe("reasoning.probe_failed");
    // Уровни остаются: фиксированные значения могут работать.
    expect(status.levels).toContain("auto");
    expect(status.levels).toContain("high");
  });

  it("shows no note when the probe confirmed the mechanism", () => {
    expect(reasoningStatus({ strategy: "openai-effort", supported: true }).noteKey).toBeNull();
  });

  it("shows no note while the probe has not run yet", () => {
    expect(reasoningStatus({ strategy: "prompt-tag", supported: null }).noteKey).toBeNull();
  });

  it("shows only the levels the provider declared (INV-R7)", () => {
    expect(reasoningStatus({ strategy: "openai-effort", levels: ["none", "low", "medium", "high"] }).levels).toEqual([
      "auto", "default", "none", "low", "medium", "high",
    ]);
  });

  it("uses only auto/default when the endpoint declared an empty level set (LM Studio)", () => {
    // LM Studio declares off/on only — усилий нет, но выключение умеет.
    expect(reasoningStatus({ strategy: "openai-effort", levels: [] }).levels).toEqual(["auto", "default"]);
    expect(reasoningStatus({ strategy: "openai-effort", levels: [] }).noteKey).toBeNull();
  });

  it("keeps the full level set for effort-aware backends and collapses the rest", () => {
    expect(reasoningStatus({ strategy: "openai-effort" }).levels).toEqual([
      "auto", "default", "none", "low", "medium", "high", "max",
    ]);
    expect(reasoningStatus({ strategy: "prompt-tag" }).levels).toEqual([
      "auto", "default", "none", "low", "high",
    ]);
  });
});
