/**
 * A7: аналитическая задача без единого чтения не принимается как успех, а
 * успешный прогон несёт строку здоровья.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { finalizeSubagentSuccess } from "../../src/tools/subagent-result";
import type { SubagentObserver } from "../../src/tools/subagent-observer";
import { EMPTY_HEALTH, type RunHealth } from "../../src/tools/subagent-health";
import type { AgentResult } from "../../src/core/types";
import type { ToolContext } from "../../src/tools/types";

const baseDir = mkdtempSync(join(tmpdir(), "mma-subagent-health-"));
const ctx = { baseDir, sessionId: "ses_test", config: {} } as unknown as ToolContext;
const result: AgentResult = { success: true, text: "всё готово", iterationCount: 2 };

afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

function observer(filesRead: number): SubagentObserver {
  const health: RunHealth = { ...EMPTY_HEALTH, toolsOk: 1, filesRead };
  return {
    runId: "srun_test",
    callbacks: {} as SubagentObserver["callbacks"],
    health: () => health,
    start: vi.fn(),
    finish: vi.fn(),
  };
}

describe("subagent run health in the result (A7)", () => {
  it("fails an analytical run that read nothing", () => {
    const o = observer(0);
    const res = finalizeSubagentSuccess(result, { result_mode: "text" }, ctx, o, "прочитай README");
    expect(res.success).toBe(false);
    const finish = o.finish as unknown as ReturnType<typeof vi.fn>;
    expect(finish).toHaveBeenCalledOnce();
    const [status, iterations, , error] = finish.mock.calls[0];
    expect(status).toBe("failed");
    expect(iterations).toBe(2);
    expect(String(error)).toContain("without reading a single file");
  });

  it("accepts a read run and appends the health line", () => {
    const o = observer(1);
    const res = finalizeSubagentSuccess(result, { result_mode: "text" }, ctx, o, "read README");
    expect(res.success).toBe(true);
    expect(String(res.output)).toContain("run health");
    expect(String(res.output)).toContain("files read 1");
  });
});
