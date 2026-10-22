/**
 * W1.6: файлы памяти ограничены по размеру, а recovery-директива и правило в
 * память не выдаются на каждый фейлящий батч (§1.6 аудита).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, MAX_MEMORY_FILE_CHARS } from "../../src/modules/memory/store";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-mem-"));
  dirs.push(dir);
  return dir;
}

describe("memory file cap", () => {
  it("keeps the freshest tail and the header", () => {
    const store = new MemoryStore(tempDir());
    for (let i = 0; i < 500; i++) {
      store.appendRule("errors", `rule ${i}`, "cause", "solution");
    }
    const content = store.read("errors");
    expect(content.length).toBeLessThanOrEqual(MAX_MEMORY_FILE_CHARS);
    expect(content.startsWith("# Errors")).toBe(true);
    expect(content).toContain("rule 499");
  });
});

describe("recovery directive throttle", () => {
  it("emits at most one directive per refresh window, not one per failing batch", async () => {
    const added: string[] = [];
    const rules: string[] = [];
    const deps = makeToolBatchDeps({
      execute: () => ({ success: false, output: "boom" }),
      added,
    });
    deps.memoryStore = { appendRule: (_c: string, pattern: string) => rules.push(pattern) };
    const ex = new ToolBatchExecutor(deps);
    const state = createLoopState();

    for (let iteration = 1; iteration <= 20; iteration++) {
      state.iteration = iteration;
      await ex.execute(
        state,
        [{ id: "1", name: "bash", arguments: { command: "x" } }],
        new Set(),
        "",
        "",
        "task",
      );
    }

    const directives = added.filter((m) => m.includes("consecutive tool failures"));
    // Не на каждый падающий батч: 20 итераций с фейлами ⇒ единицы инжектов.
    expect(directives.length).toBeGreaterThan(0);
    expect(directives.length).toBeLessThanOrEqual(3);
    expect(rules.length).toBeLessThanOrEqual(3);
  });
});
