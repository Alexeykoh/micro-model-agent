import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../src/tools/registry";
import { ToolExecutor } from "../../src/tools/executor";
import { bashTool, isMemoizableCommand } from "../../src/tools/bash";
import type { ToolDefinition } from "../../src/tools/types";

function makeCtx(sessionId = "ses_test") {
  const ctx: any = {
    baseDir: process.cwd(),
    config: { security: { enabled: false } },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      logToolCall: () => {},
      logToolOutput: () => {},
    },
    sessionId,
  };
  return ctx;
}

function countingTool(name: string, cacheable: boolean, calls: { n: number }, fail = false): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    ...(cacheable ? { cacheable: true } : {}),
    handler: async () => {
      calls.n += 1;
      return fail
        ? { success: false, output: `fail #${calls.n}` }
        : { success: true, output: `ok #${calls.n}` };
    },
  };
}

function setup() {
  const registry = new ToolRegistry();
  const ctx = makeCtx();
  const executor = new ToolExecutor(registry, ctx, { getAllPlugins: () => [] });
  ctx.toolExecutor = executor;
  return { registry, ctx, executor };
}

describe("executor memo: cacheable tools", () => {
  it("serves repeats without re-running the handler", async () => {
    const { registry, executor } = setup();
    const calls = { n: 0 };
    registry.register(countingTool("pure_read", true, calls));
    const args = { path: "a.txt" };
    const first = await executor.execute({ id: "c1", name: "pure_read", arguments: args });
    const second = await executor.execute({ id: "c2", name: "pure_read", arguments: args });
    expect(calls.n).toBe(1);
    expect(first.output).toBe(second.output);
    expect(second.toolCallId).toBe("c2");
  });

  it("re-runs on different args and different sessions", async () => {
    const { registry, ctx, executor } = setup();
    const calls = { n: 0 };
    registry.register(countingTool("pure_read", true, calls));
    await executor.execute({ id: "c1", name: "pure_read", arguments: { path: "a.txt" } });
    await executor.execute({ id: "c2", name: "pure_read", arguments: { path: "b.txt" } });
    expect(calls.n).toBe(2);
    ctx.sessionId = "ses_other";
    await executor.execute({ id: "c3", name: "pure_read", arguments: { path: "a.txt" } });
    expect(calls.n).toBe(3);
  });

  it("a non-cacheable execution wipes the memo", async () => {
    const { registry, executor } = setup();
    const reads = { n: 0 };
    const writes = { n: 0 };
    registry.register(countingTool("pure_read", true, reads));
    registry.register(countingTool("do_mutate", false, writes));
    await executor.execute({ id: "c1", name: "pure_read", arguments: {} });
    expect(reads.n).toBe(1);
    await executor.execute({ id: "c2", name: "do_mutate", arguments: {} });
    await executor.execute({ id: "c3", name: "pure_read", arguments: {} });
    expect(reads.n).toBe(2);
  });

  it("does not memoize failures", async () => {
    const { registry, executor } = setup();
    const calls = { n: 0 };
    registry.register(countingTool("flaky_read", true, calls, true));
    await executor.execute({ id: "c1", name: "flaky_read", arguments: {} });
    await executor.execute({ id: "c2", name: "flaky_read", arguments: {} });
    expect(calls.n).toBe(2);
  });
});

describe("isMemoizableCommand", () => {
  it("accepts single read-only invocations", () => {
    for (const cmd of [
      "npm view micro-models-agent version",
      "git status --short",
      "git log --oneline -5",
      "dir",
      "echo hi",
      "node --version",
    ]) {
      expect(isMemoizableCommand(cmd)).toBe(true);
    }
  });

  it("rejects mutating and compound commands", () => {
    for (const cmd of [
      "npm publish --access public",
      "git push origin master",
      "echo hi && echo there",
      "npm view x | head",
      "echo hi > out.txt",
      "ping -n 30 127.0.0.1",
      "",
      "directx-info",
    ]) {
      expect(isMemoizableCommand(cmd)).toBe(false);
    }
  });
});

describe("bash memo through the handler", () => {
  it("serves a repeated read-only command from the memo", async () => {
    const { ctx } = setup();
    const args = { command: "echo memo-probe" };
    const first = await bashTool.handler(ctx, args);
    const second = await bashTool.handler(ctx, args);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.output).toBe(first.output);
  });
});
