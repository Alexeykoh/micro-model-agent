import { describe, it, expect } from "vitest";
import {
  buildPromptSnapshot,
  diffPrompt,
  serializeMessages,
  serializeTools,
  type PromptSnapshot,
} from "../src/core/agent/prefix-monitor";

/** Счётчик «токенов» для тестов: один токен = один символ. */
const count = (s: string): number => s.length;

function snap(system: string, tools = "", history = ""): PromptSnapshot {
  return { system, tools, history };
}

describe("diffPrompt", () => {
  it("reports a fully intact prefix for identical snapshots", () => {
    const s = snap("SYSTEM", "TOOLS", "HISTORY");
    const d = diffPrompt(s, s, count);
    expect(d.cause).toBe("none");
    expect(d.stableRatio).toBe(1);
    expect(d.commonPrefixTokens).toBe(d.currTokens);
  });

  it("treats an appended history turn as a prefix hit (cache-friendly)", () => {
    const prev = snap("SYS", "T", "turn1");
    const curr = snap("SYS", "T", "turn1turn2");
    const d = diffPrompt(prev, curr, count);
    expect(d.cause).toBe("none");
    // Общий префикс покрывает весь предыдущий промпт (включая разделители).
    expect(d.commonPrefixTokens).toBeGreaterThanOrEqual(
      prev.system.length + prev.tools.length + prev.history.length,
    );
    expect(d.stableRatio).toBeGreaterThan(0.5);
    expect(d.stableRatio).toBeLessThan(1);
  });

  it("flags a changed system block", () => {
    const d = diffPrompt(snap("SYSTEM-A", "T", "H"), snap("SYSTEM-B", "T", "H"), count);
    expect(d.cause).toBe("system");
    // Совпало "SYSTEM-" — расхождение на последнем символе блока.
    expect(d.commonPrefixTokens).toBe("SYSTEM-".length);
  });

  it("flags changed tool definitions", () => {
    const d = diffPrompt(snap("SYS", "TOOLS-A", "H"), snap("SYS", "TOOLS-B", "H"), count);
    expect(d.cause).toBe("tools");
  });

  it("flags a rewritten history (compaction)", () => {
    const d = diffPrompt(snap("SYS", "T", "aaaa-bbbb"), snap("SYS", "T", "aaaa-cccc"), count);
    expect(d.cause).toBe("history");
  });

  it("overrides the cause with 'volatile' for a timestamp near the divergence", () => {
    const d = diffPrompt(
      snap("Generated at 2026-09-17T12:00:00Z", "T", "H"),
      snap("Generated at 2026-09-17T12:00:01Z", "T", "H"),
      count,
    );
    expect(d.cause).toBe("volatile");
  });

  it("returns 'unknown' with no previous snapshot", () => {
    const d = diffPrompt(undefined, snap("SYS", "T", "H"), count);
    expect(d.cause).toBe("unknown");
    expect(d.commonPrefixTokens).toBe(0);
    expect(d.stableRatio).toBe(0);
  });

  it("handles an empty current prompt without dividing by zero", () => {
    const d = diffPrompt(snap("SYS"), snap(""), count);
    expect(d.stableRatio).toBe(0);
    expect(Number.isFinite(d.stableRatio)).toBe(true);
  });
});

describe("serializers", () => {
  it("serializes tools deterministically", () => {
    const a = serializeTools([
      { name: "read_file", description: "Read", parameters: { type: "object" } },
    ]);
    const b = serializeTools([
      { name: "read_file", description: "Read", parameters: { type: "object" } },
    ]);
    expect(a).toBe(b);
    expect(a).toContain("read_file");
  });

  it("splits system messages from history and serializes tools", () => {
    const s = buildPromptSnapshot(
      [
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ],
      [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
    );
    expect(s.system).toContain("SYS");
    expect(s.history).toContain("hi");
    expect(s.history).not.toContain("SYS");
    expect(s.tools).toContain("read_file");
  });

  it("serializes message content and roles", () => {
    const s = serializeMessages([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(s).toContain("user");
    expect(s).toContain("hello");
    expect(s).toContain("assistant");
    expect(s).toContain("hi");
  });
});
