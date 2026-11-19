import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishSubagentRun,
  listSubagentRuns,
  registerSubagentRun,
  resetSubagentRegistry,
  setSubagentRunStop,
  stopSubagentRun,
} from "../../src/tools/subagent-registry";
import { listSubagents } from "../../src/tools/subagent-list";
import { stopSubagent } from "../../src/tools/subagent-stop";
import type { ToolContext } from "../../src/tools/types";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    baseDir: "/tmp",
    config: { experts: { code: { tool_tags: ["code"] } } },
    sessionId: "ses_parent",
    ...over,
  } as ToolContext;
}

beforeEach(() => resetSubagentRegistry());
afterEach(() => resetSubagentRegistry());

describe("subagent registry", () => {
  it("lists only runs of the current session", () => {
    registerSubagentRun({ runId: "a", parentSessionId: "ses_parent", task: "one", startedAt: 1 });
    registerSubagentRun({ runId: "b", parentSessionId: "ses_other", task: "two", startedAt: 2 });

    expect(listSubagentRuns("ses_parent").map((r) => r.runId)).toEqual(["a"]);
    expect(listSubagentRuns()).toHaveLength(2);
  });

  it("stops a running run and refuses finished/foreign runs", () => {
    const stop = vi.fn();
    registerSubagentRun({ runId: "a", parentSessionId: "ses_parent", task: "one", startedAt: 1 });
    setSubagentRunStop("a", stop);

    expect(stopSubagentRun("a", "ses_other")).toBe("not_found");
    expect(stopSubagentRun("a", "ses_parent")).toBe("ok");
    expect(stop).toHaveBeenCalledOnce();

    finishSubagentRun("a", { status: "done", endedAt: 2 });
    expect(stopSubagentRun("a", "ses_parent")).toBe("not_running");
  });

  it("includes finished runs only when asked", async () => {
    registerSubagentRun({ runId: "a", parentSessionId: "ses_parent", task: "one", startedAt: 1 });
    finishSubagentRun("a", { status: "done", endedAt: 2 });

    const running = await listSubagents(ctx(), {});
    expect(running.output).not.toContain("srun_");
    expect(running.output).not.toContain("a | done");

    const all = await listSubagents(ctx(), { include_finished: true });
    expect(all.output).toContain("a | done");
    expect(all.output).toContain("code");
  });

  it("stop tool reports unknown ids honestly", async () => {
    const result = await stopSubagent(ctx(), { run_id: "nope" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("nope");
  });
});
