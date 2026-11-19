import { describe, it, expect } from "vitest";
import { processKillTool } from "../../src/tools/process-kill";
import { processLogTool } from "../../src/tools/process-log";
import { processWaitTool } from "../../src/tools/process-wait";

/**
 * ses_mt4fn58c: `process_kill -p=5173` (via bash redirect) produced
 * "Process not found: undefined" — the model got no hint about the correct
 * id= argument format and no list of valid ids.
 */
describe("process tools: missing-id usage hint", () => {
  const tools = {
    process_kill: processKillTool,
    process_log: processLogTool,
    process_wait: processWaitTool,
  } as const;

  for (const [name, tool] of Object.entries(tools)) {
    it(`${name} without id returns a usage hint with known process ids`, async () => {
      const res = await tool.handler!({} as any, {} as any);
      expect(res.success).toBe(false);
      expect(res.output).toContain("id=");
      expect(res.output.toLowerCase()).not.toContain("undefined");
    });

    it(`${name} with a wrong-but-present id still reports not found`, async () => {
      const res = await tool.handler!({} as any, { id: "proc_nope" } as any);
      expect(res.success).toBe(false);
      expect(res.output).toContain("proc_nope");
    });
  }
});
