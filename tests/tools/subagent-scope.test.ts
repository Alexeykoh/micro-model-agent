/**
 * A1 (`TODO` §1.8): записи скоупа нормализуются при спавне, невалидные
 * отвергаются с внятной причиной, glob-форма не считается мусором.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { runSubagent } from "../../src/tools/subagent-run";
import type { ToolContext } from "../../src/tools/types";

function makeCtx(): ToolContext {
  return {
    baseDir: resolve("/workspace"),
    config: {},
    sessionId: "ses_scope_test",
    logger: { info: () => {}, error: () => {} },
  } as unknown as ToolContext;
}

describe("subagent: валидация записей скоупа", () => {
  it("отвергает запись с .. и перечисляет её", async () => {
    const res = await runSubagent(makeCtx(), { task: "t", allowed_files: ["../escape"] });
    expect(res.success).toBe(false);
    expect(res.output).toContain("../escape");
    expect(res.output).toContain("'..'");
  });

  it("отвергает пустую запись", async () => {
    const res = await runSubagent(makeCtx(), { task: "t", read_only_files: [""] });
    expect(res.success).toBe(false);
    expect(res.output).toContain("empty entry");
  });

  it("glob-форма проходит валидацию (раньше давала «нет доступа»)", async () => {
    const res = await runSubagent(makeCtx(), { task: "t", allowed_files: ["src/**/*"] });
    expect(res.success).toBe(false);
    // Дальше прогон не идёт: в контексте нет провайдера/исполнителя.
    expect(res.output).not.toContain("scope");
    expect(res.output).toContain("Sub-agent cannot run");
  });
});
