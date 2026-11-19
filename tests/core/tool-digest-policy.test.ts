/**
 * Политика дублирования выводов тулов в `<system-summary>`.
 *
 * Spec 2026-10-26-tool-digest-channel-design: в `ses_mvphq4s8` каждый результат
 * тула попадал в контекст дважды (role:"tool" + дайджест `[Tool: …]`), 50 из 53
 * директив — эти дайджесты, ~6,7 тыс. токенов за прогон.
 */
import { describe, expect, it } from "vitest";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";
import type { ToolResult } from "../../src/tools/types";

function run(mode: "full" | "failures" | "off", results: ToolResult[]) {
  const added: string[] = [];
  let i = 0;
  const deps = makeToolBatchDeps({ added, execute: () => results[i++ % results.length] });
  deps.config.contextBudget = { toolDigest: mode };
  const ex = new ToolBatchExecutor(deps);
  const state = createLoopState();
  const calls = results.map((_, n) => ({
    id: String(n),
    name: "read_file",
    arguments: { path: `src/f${n}.ts` },
  }));
  return ex
    .execute(state, calls, new Set(), "читаю файлы", "", "task")
    .then(() => added.filter((m) => m.includes("<system-summary>")));
}

const OK: ToolResult = { success: true, output: "content" };
const FAIL: ToolResult = { success: false, output: "boom" };

describe("политика дайджеста тулов", () => {
  it("full — дайджест каждого вызова (историческое поведение)", async () => {
    const added = await run("full", [OK, FAIL]);
    expect(added.join("\n").match(/\[Tool: /g)?.length).toBe(2);
  });

  it("failures — только упавший вызов", async () => {
    const added = await run("failures", [OK, FAIL]);
    const text = added.join("\n");
    expect(text.match(/\[Tool: /g)?.length).toBe(1);
    expect(text).toContain("boom");
    expect(text).not.toContain("content");
  });

  it("off — дайджестов нет вовсе", async () => {
    const added = await run("off", [OK, FAIL]);
    expect(added.join("\n")).not.toContain("[Tool: ");
  });

  it("пустая сводка не добавляется в контекст", async () => {
    const added = await run("off", [OK]);
    expect(added).toEqual([]);
  });
});
