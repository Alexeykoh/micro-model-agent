// Стор прогонов субагентов: seq, скраб, капы, вытеснение, приватность сессии.
import { describe, it, expect } from "vitest";
import {
  SubagentRunStore,
  SUBAGENT_RUNS_PER_SESSION,
  SUBAGENT_TOOL_OUTPUT_CAP,
} from "../src/modules/webui/session/subagent-runs";
import type { SubagentRunEvent } from "../src/tools/subagent-runs";

const send = () => {};

function start(runId: string, sessionId = "s1", toolCallId?: string): SubagentRunEvent {
  return {
    kind: "start",
    runId,
    parentSessionId: sessionId,
    parentToolCallId: toolCallId,
    depth: 1,
    task: "task",
    at: 1000,
  };
}

function end(runId: string): SubagentRunEvent {
  return {
    kind: "end",
    runId,
    status: "done",
    iterations: 1,
    durationMs: 5,
    output: "out",
  };
}

describe("SubagentRunStore", () => {
  it("assigns monotonic seq and closes the run once", () => {
    const s = new SubagentRunStore();
    s.ingest(start("r1"), send);
    s.ingest({ kind: "phase", runId: "r1", phase: "thinking" }, send);
    s.ingest(end("r1"), send);
    s.ingest({ kind: "text", runId: "r1", chunk: "late" }, send); // после end игнор
    const snap = s.get("s1", "r1");
    expect(snap).toBeDefined();
    expect(snap?.status).toBe("done");
    expect(snap?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(snap?.events.map((e) => e.kind)).toEqual(["start", "phase", "end"]);
  });

  it("scrubs ANSI from text and clips tool output", () => {
    const s = new SubagentRunStore();
    s.ingest(start("r1"), send);
    s.ingest({ kind: "text", runId: "r1", chunk: "\u001b[31mred\u001b[0m" }, send);
    s.ingest(
      {
        kind: "tool_end",
        runId: "r1",
        callId: "c",
        tool: "read_file",
        success: true,
        output: "x".repeat(SUBAGENT_TOOL_OUTPUT_CAP + 50),
      },
      send,
    );
    s.ingest(end("r1"), send);
    const events = s.get("s1", "r1")?.events ?? [];
    const text = events.find((e) => e.kind === "text");
    expect(text && "chunk" in text ? text.chunk : "").toBe("red");
    const tool = events.find((e) => e.kind === "tool_end");
    expect(tool && "output" in tool ? tool.output?.length : 0).toBeGreaterThan(
      SUBAGENT_TOOL_OUTPUT_CAP,
    );
    expect(tool && "output" in tool ? tool.output : "").toContain("[truncated from");
  });

  it("filters by parent tool call id", () => {
    const s = new SubagentRunStore();
    s.ingest(start("r1", "s1", "call_a"), send);
    s.ingest(start("r2", "s1", "call_b"), send);
    expect(s.list("s1", "call_a").map((r) => r.runId)).toEqual(["r1"]);
    expect(s.list("s1").map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("never exposes a run of another session", () => {
    const s = new SubagentRunStore();
    s.ingest(start("r1", "s1"), send);
    expect(s.get("s2", "r1")).toBeUndefined();
    expect(s.list("s2")).toEqual([]);
  });

  it("retains at most the per-session cap, oldest finished first", () => {
    const s = new SubagentRunStore();
    for (let i = 0; i < SUBAGENT_RUNS_PER_SESSION + 1; i++) {
      const id = `r${i}`;
      s.ingest(start(id), send);
      s.ingest(end(id), send);
    }
    const list = s.list("s1");
    expect(list).toHaveLength(SUBAGENT_RUNS_PER_SESSION);
    expect(list[list.length - 1].runId).toBe(`r${SUBAGENT_RUNS_PER_SESSION}`);
    expect(s.get("s1", "r0")).toBeUndefined();
  });

  it("forgetSession drops its runs only", () => {
    const s = new SubagentRunStore();
    s.ingest(start("a", "s1"), send);
    s.ingest(start("b", "s2"), send);
    s.forgetSession("s1");
    expect(s.list("s1")).toEqual([]);
    expect(s.list("s2").map((r) => r.runId)).toEqual(["b"]);
  });

  it("ignores events without a known start", () => {
    const s = new SubagentRunStore();
    s.ingest({ kind: "text", runId: "ghost", chunk: "x" }, send);
    expect(s.list("s1")).toEqual([]);
  });
});


