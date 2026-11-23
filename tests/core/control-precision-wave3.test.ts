// BCP-4/7: санитизация сводки компакции и аннулирование stale-правил памяти.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { omitStaleErrorLines } from "../../src/core/context/compaction-summary-sanitize";
import { MemoryStore } from "../../src/modules/memory/store";
import { recordRepeatedToolFailure } from "../../src/core/agent/failure-memory";
import { createLoopState, recordBatchProgress } from "../../src/core/agent/loop-state";

describe("wastefulToolCalls: метрика напрасных вызовов", () => {
  it("считает дублирующие пакеты и неудачи тулов", () => {
    const state = createLoopState();
    const deps = {
      contextManager: { addMessage: () => undefined } as never,
      logger: { diagnostic: () => undefined } as never,
    };
    expect(state.wastefulToolCalls).toBe(0);

    recordBatchProgress(state, ["read_file::a"], false);
    expect(state.wastefulToolCalls).toBe(0);
    recordBatchProgress(state, ["read_file::a"], true);
    expect(state.wastefulToolCalls).toBe(1);

    recordRepeatedToolFailure(
      state,
      { id: "1", name: "mcp_call", arguments: {} } as never,
      { success: false, output: "No open pages available" } as never,
      deps,
    );
    expect(state.wastefulToolCalls).toBe(2);
  });
});

describe("BCP-4: сводка компакции", () => {
  it("убирает старые ошибки из tool ledger", () => {
    const lines = [
      "- patch_file(path) → Applied 1 edits",
      "- bash(command) → command failed: missing module",
      "- read_file(path) → ok",
    ];
    expect(omitStaleErrorLines(lines)).toEqual([
      "- patch_file(path) → Applied 1 edits",
      "- read_file(path) → ok",
    ]);
  });
});

describe("BCP-7: TTL правил памяти", () => {
  it("успешный повтор тула удаляет правило об его падениях", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcp7-"));
    try {
      const store = new MemoryStore(dir, { enabled: false });
      store.appendRule("errors", "plan_step failed 3x", "check gated", "edit file first");
      const before = readFileSync(join(dir, "errors.md"), "utf-8");
      expect(before).toContain("plan_step failed");

      const state = createLoopState();
      const deps = {
        memoryStore: store,
        contextManager: { addMessage: () => undefined } as never,
        logger: { diagnostic: () => undefined } as never,
      };
      recordRepeatedToolFailure(
        state,
        { id: "1", name: "plan_step", arguments: {} } as never,
        { success: true, output: "Step done" },
        deps,
      );
      const after = readFileSync(join(dir, "errors.md"), "utf-8");
      expect(after).not.toContain("plan_step failed");
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });
});
