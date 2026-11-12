import { describe, it, expect } from "bun:test";
import { refreshSystemInfoBlock } from "../../src/core/system-prompt";
import { estimateTokens } from "../../src/llm/token-counter";

function depsWith(config: Record<string, unknown>, systemContent: string | null) {
  const promptBlocks: Array<Record<string, unknown>> = [
    { source: "other", label: "keep", content: "KEEP", priority: "low", essential: false, estimatedTokens: 1 },
  ];
  if (systemContent !== null) {
    promptBlocks.unshift({
      source: "core",
      label: "system",
      content: systemContent,
      priority: "critical",
      essential: true,
      estimatedTokens: 5,
    });
  }
  return {
    config: {
      autoPlan: false,
      security: { enabled: false },
      mcpServers: {},
      lsp: { enabled: false },
      ...config,
    },
    baseDir: "/tmp",
    profileCompressed: "prof",
    promptBlocks,
  } as never;
}

describe("live static block (B14)", () => {
  it("rebuilds the system block from the live config", () => {
    const deps = depsWith({ autoPlan: false }, "STALE");
    expect(refreshSystemInfoBlock(deps)).toBe(true);
    const blocks = deps.promptBlocks as Array<{ content: string; estimatedTokens: number }>;
    expect(blocks[0].content).not.toContain("STALE");
    expect(blocks[0].content).not.toContain("PLAN QUALITY");
    expect(blocks[0].estimatedTokens).toBe(estimateTokens(blocks[0].content));

    (deps.config as { autoPlan: boolean }).autoPlan = true;
    expect(refreshSystemInfoBlock(deps)).toBe(true);
    expect(blocks[0].content).toContain("PLAN QUALITY");
  });

  it("keeps block order and leaves neighbours alone", () => {
    const deps = depsWith({}, "STALE");
    refreshSystemInfoBlock(deps);
    const blocks = deps.promptBlocks as Array<{ label: string; content: string }>;
    expect(blocks.map((b) => b.label)).toEqual(["system", "keep"]);
    expect(blocks[1].content).toBe("KEEP");
  });

  it("returns false without a profile or without a system block", () => {
    const noProfile = depsWith({}, "STALE") as unknown as Record<string, unknown>;
    delete noProfile.profileCompressed;
    expect(refreshSystemInfoBlock(noProfile as never)).toBe(false);
    expect(refreshSystemInfoBlock(depsWith({}, null))).toBe(false);
  });
});
