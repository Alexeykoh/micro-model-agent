import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createLoopState, type LoopState } from "../../src/core/agent/loop-state";
import { snapshotLoopState, restoreLoopState, parseTurnCheckpoint } from "../../src/modules/session/checkpoint";
import { SessionStore } from "../../src/modules/session/store";

describe("checkpoint snapshot/restore", () => {
  it("round-trips counters through JSON (including Sets/Maps)", () => {
    const state = createLoopState();
    state.iteration = 7;
    state.pendingCompaction = true;
    state.seenToolCalls.add("read_file:{\"path\":\"a\"}");
    state.disabledTools.add("browser");
    state.toolFailureCounts.set("bash", { count: 3, error: "boom", samples: ["s"] });
    state.toolTargetCounts.set("f.ts", 4);
    state.memoryRuleRecorded.add("bash");
    state.cycleNudgedKeys.add("f.ts");
    state.seenCriticIssues.add("issue#1");
    state.consecutiveDuplicateBatches = 5;
    state.finalAnswerAccepted = true;

    const snap = snapshotLoopState(state, "thr_0123456789abcdef");
    const json = JSON.stringify(snap);

    const fresh = createLoopState();
    expect(restoreLoopState(fresh, JSON.parse(json) as never)).toBe(true);
    expect(fresh.iteration).toBe(7);
    expect(fresh.pendingCompaction).toBe(true);
    expect(fresh.seenToolCalls.has("read_file:{\"path\":\"a\"}")).toBe(true);
    expect(fresh.disabledTools.has("browser")).toBe(true);
    expect(fresh.toolFailureCounts.get("bash")).toMatchObject({ count: 3 });
    expect(fresh.toolTargetCounts.get("f.ts")).toBe(4);
    expect(fresh.memoryRuleRecorded.has("bash")).toBe(true);
    expect(fresh.seenCriticIssues.has("issue#1")).toBe(true);
    expect(fresh.consecutiveDuplicateBatches).toBe(5);
    expect(fresh.finalAnswerAccepted).toBe(true);
  });

  it("rejects wrong version and unparseable input (fail-open)", () => {
    expect(parseTurnCheckpoint("not json")).toBeNull();
    expect(parseTurnCheckpoint(JSON.stringify({ v: 99, iteration: 3 }))).toBeNull();
    expect(parseTurnCheckpoint(JSON.stringify({ v: 1, iteration: "x" }))).toBeNull();
    const state = createLoopState();
    state.iteration = 5;
    expect(restoreLoopState(state, { v: 99 } as never)).toBe(false);
    expect(state.iteration).toBe(5);
  });
});

describe("checkpoint store (file)", () => {
  it("saves/loads, no .tmp left; broken file → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-checkpoint-"));
    const store = new SessionStore(dir);
    const state = createLoopState();
    state.iteration = 11;
    state.pendingCompaction = true;
    store.saveCheckpoint("ses_1", snapshotLoopState(state, "thr_0123456789abcdef"));

    const loaded = store.loadCheckpoint("ses_1");
    expect(loaded?.iteration).toBe(11);
    expect(loaded?.pendingCompaction).toBe(true);
    // Атомарная запись не оставила .tmp-мусор.
    expect(readdirSync(join(dir, "ses_1")).some((f) => f.endsWith(".tmp"))).toBe(false);

    // Битый файл → null, а не throw.
    writeFileSync(join(dir, "ses_1", "checkpoint.json"), "broken{", "utf-8");
    expect(store.loadCheckpoint("ses_1")).toBeNull();
    // Нет сессии → null.
    expect(store.loadCheckpoint("unknown")).toBeNull();
  });
});
