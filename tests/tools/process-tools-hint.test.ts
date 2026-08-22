import { describe, it, expect } from "vitest";
import { processKillTool } from "../../src/tools/process-kill";
import { processLogTool } from "../../src/tools/process-log";

/**
 * ses_mt4fn58c: `process_kill -p=5173` (via bash redirect) produced
 * "Process not found: undefined" — the model got no hint about the correct
 * id= argument format and no list of valid ids.
 */
describe("process tools: missing-id usage hint", () => {
  it("process_kill without id returns a usage hint with known process ids", async () => {
    const res = await processKillTool.handler!({} as any, {} as any);
    expect(res.success).toBe(false);
    expect(res.output).toContain("id=");
    expect(res.output.toLowerCase()).not.toContain("undefined");
  });

  it("process_log without id returns a usage hint", async () => {
    const res = await processLogTool.handler!({} as any, {} as any);
    expect(res.success).toBe(false);
    expect(res.output).toContain("id=");
    expect(res.output.toLowerCase()).not.toContain("undefined");
  });

  it("process_kill with a wrong-but-present id still reports not found", async () => {
    const res = await processKillTool.handler!({} as any, { id: "proc_nope" } as any);
    expect(res.success).toBe(false);
    expect(res.output).toContain("proc_nope");
  });
});
