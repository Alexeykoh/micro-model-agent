import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";

/**
 * ses_mt4fn58c post-mortem: after bash failed 3 times early in the session,
 * the identical "Tool bash failed N times" stuck-warning was re-logged after
 * ~30 SUCCESSFUL write_file calls, and "No write/exec for N tool calls" was
 * re-logged on every read — flooding the context and forcing compactions.
 */
describe("stuck warning anti-spam", () => {
  let tmpDir: string;
  let mod: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-stuckwarn-"));
    mod = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  function makeCtx() {
    return {
      contextManager: { addMessage: vi.fn() },
      sessionLog: { plan: vi.fn() },
      logger: { warn: vi.fn(), debug: vi.fn() },
      iteration: 0,
    } as any;
  }

  async function createPlan() {
    const planToolDef = mod.getToolDefinitions().find((t) => t.name === "plan")!;
    await planToolDef.handler({}, { action: "create", title: "T", steps: ["Create src/a.ts"] });
  }

  function stuckWarningCount(ctx: ReturnType<typeof makeCtx>): number {
    return ctx.sessionLog.plan.mock.calls.filter((a: any[]) => a[0] === "stuck-warning").length;
  }

  it("stops logging stale tool-errors after subsequent successes", async () => {
    await createPlan();
    const plugin: any = mod.getPlugin();
    const c = makeCtx();

    const bashFail: any = { id: "c1", name: "bash", arguments: { command: "bun run x" } };
    const failRes: any = { success: false, output: "Command failed with exit code 1" };
    for (let i = 0; i < 3; i++) await plugin.onAfterTool(c, bashFail, failRes);

    const writeCall: any = { id: "w", name: "write_file", arguments: { path: "src/a.ts" } };
    const okRes: any = { success: true, output: "Written" };
    for (let i = 1; i <= 8; i++) {
      c.iteration = i;
      await plugin.onAfterTool(c, writeCall, okRes);
      plugin.onBeforeThink(c);
    }

    // At most the initial warning plus one cooldown re-log — not one per call.
    expect(stuckWarningCount(c)).toBeLessThanOrEqual(2);
  });

  it("does not re-log the read-only-loop warning on every read", async () => {
    await createPlan();
    const plugin: any = mod.getPlugin();
    const c = makeCtx();

    const readCall: any = { id: "r", name: "read_file", arguments: { path: "src/a.ts" } };
    const okRes: any = { success: true, output: "--- file ---" };
    for (let i = 1; i <= 20; i++) {
      c.iteration = i;
      plugin.onToolCall({ toolName: "read_file", args: readCall.arguments });
      await plugin.onAfterTool(c, readCall, okRes);
      plugin.onBeforeThink(c);
    }

    expect(stuckWarningCount(c)).toBeLessThanOrEqual(4);
  });
});
