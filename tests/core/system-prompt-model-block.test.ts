import { describe, it, expect } from "vitest";
import { buildModelBlock, buildSystemInfo } from "../../src/core/system-prompt";

// Session ses_mv44qabg_s1przq ran on mellum2.1-12b while the system prompt still
// said qwen3.8-9b-distill: the model name was baked into the static system-info
// block at bootstrap and never rebuilt on model/provider switch. Identity now
// lives in a dynamic block (recomputed each prompt build).
describe("dynamic model identity", () => {
  it("renders the active model", () => {
    const b = buildModelBlock("mellum2.1-12b-a2.5b-thinking");
    expect(b.content).toContain("mellum2.1-12b-a2.5b-thinking");
    expect(b.priority).toBe("low");
  });

  it("changes with the model (fresh per build)", () => {
    expect(buildModelBlock("model-a").content).toContain("model-a");
    expect(buildModelBlock("model-b").content).toContain("model-b");
  });

  it("is the only source — the static header no longer embeds a model name", () => {
    const info = buildSystemInfo({ model: "stale-model-x" } as never, "/tmp", "win32");
    expect(info).toContain("You are MMA v2");
    expect(info).not.toContain("stale-model-x");
  });
});
