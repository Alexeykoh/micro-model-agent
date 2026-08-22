import { describe, it, expect } from "vitest";
import { bashTool } from "../src/tools/bash";

/**
 * ses_mt4fn58c: with tool-set narrowing the process_* tools are hidden
 * (tag "shell" not in defaultTags). The model tried to run them through
 * bash ("process_list") and got cmd.exe's "not recognized" error three
 * times — it never learned the tools exist behind enable_tools.
 */
describe("bash: hidden process_* tool hint", () => {
  const ctx = {
    baseDir: process.cwd(),
    config: { security: { enabled: false } },
    logger: { info: () => {}, error: () => {} },
    toolExecutor: { hasTool: (name: string) => ["process_list", "process_log", "process_kill"].includes(name) },
  } as any;

  it("process_list via bash returns an enable_tools hint instead of a shell error", async () => {
    const res = await bashTool.handler(ctx, { command: "process_list" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("enable_tools");
    expect(res.output).not.toContain("не является внутренней");
  });

  it("process_kill id=proc_x still redirects into the real tool (usage answer)", async () => {
    // k=v commands keep the existing redirect-into-tool behavior — the real
    // tool answers with a proper usage/not-found message (Fix 5).
    const redirectCtx = {
      ...ctx,
      toolExecutor: {
        hasTool: ctx.toolExecutor.hasTool,
        executeByName: async (_name: string, _args: any) => ({
          success: false,
          output: "Process not found: proc_x",
        }),
      },
    };
    const res = await bashTool.handler(redirectCtx, { command: "process_kill id=proc_x" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("redirected to tool");
    expect(res.output).not.toContain("не является внутренней");
  });

  it("normal commands are unaffected", async () => {
    const res = await bashTool.handler(ctx, { command: "echo hi" });
    expect(res.success).toBe(true);
    expect(res.output.trim()).toBe("hi");
  });
});
