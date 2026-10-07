import { describe, it, expect } from "vitest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolDefinition } from "../../src/tools/types";

const noPlugins = { getAllPlugins: () => [] } as any;

/** Context with a LIVE config getter (mirrors bootstrap wiring). */
function makeCtx(liveConfig: { current: Record<string, unknown> }) {
  const ctx: any = {
    recursionDepth: 0,
    scope: undefined,
    sessionId: "s1",
    logger: {
      logToolCall: () => {},
      logToolOutput: () => {},
      debug: () => {},
      warn: () => {},
    },
  };
  Object.defineProperty(ctx, "config", { get: () => liveConfig.current, configurable: true });
  return ctx;
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const read: ToolDefinition = {
    name: "read",
    description: "read",
    parameters: { type: "object", properties: {} },
    cacheable: true,
    handler: async (ctx) => ({
      success: true,
      output: `read ${JSON.stringify(ctx.config)}`,
    }),
  };
  const mutate: ToolDefinition = {
    name: "mutate",
    description: "mutate",
    parameters: { type: "object", properties: {} },
    handler: async () => ({ success: true, output: "mutated" }),
  };
  registry.register(read);
  registry.register(mutate);
  return registry;
}

describe("ToolExecutor.fork", () => {
  it("isolates scope, recursionDepth, cleanup and activeCallId from the parent", () => {
    const live = { current: { model: "a" } };
    const ctx = makeCtx(live);
    const parent = new ToolExecutor(makeRegistry(), ctx, noPlugins);

    parent.setScope({ allowed_files: ["a.ts"], read_only_files: [] });
    parent.setRecursionDepth(1);
    ctx.cleanup = () => {};
    ctx.activeCallId = "parent-call";

    const fork = parent.fork();
    fork.setScope({ allowed_files: ["b.ts"], read_only_files: [] });
    fork.setRecursionDepth(2);
    (fork as any).ctx.cleanup = () => {};

    expect(parent.getScope()?.allowed_files).toEqual(["a.ts"]);
    expect((fork as any).ctx.scope.allowed_files).toEqual(["b.ts"]);
    expect(parent.getRecursionDepth()).toBe(1);
    expect(fork.getRecursionDepth()).toBe(2);
    expect((fork as any).ctx.activeCallId).toBeUndefined();
    expect(ctx.cleanup).toBeDefined();
  });

  it("keeps live getters live across the fork", async () => {
    const live = { current: { model: "a" } };
    const ctx = makeCtx(live);
    const parent = new ToolExecutor(makeRegistry(), ctx, noPlugins);
    const fork = parent.fork();

    live.current = { model: "b" };
    const result = await fork.execute({ id: "1", name: "read", arguments: {} });
    expect(result.output).toContain('"model":"b"');
  });

  it("serializes plugin hooks across sibling forks (shared hook lock)", async () => {
    const live = { current: {} };
    const ctx = makeCtx(live);
    let active = 0;
    let maxActive = 0;
    const plugins = {
      getAllPlugins: () => [
        {
          name: "stateful",
          onBeforeTool: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 15));
            active--;
            return true;
          },
        },
      ],
    } as any;
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: true, output: "ok" }),
    });
    const parent = new ToolExecutor(registry, ctx, plugins);
    await Promise.all([
      parent.fork().execute({ id: "1", name: "noop", arguments: {} }),
      parent.fork().execute({ id: "2", name: "noop", arguments: {} }),
    ]);
    // Hooks never overlapped: the shared lock made dispatch mutually exclusive.
    expect(maxActive).toBe(1);
  });

  it("shares the memo: a fork's non-cacheable run invalidates the parent cache", async () => {
    const live = { current: {} };
    const ctx = makeCtx(live);
    const registry = makeRegistry();
    let readCalls = 0;
    registry.get("read")!.handler = async () => {
      readCalls++;
      return { success: true, output: "read" };
    };
    const parent = new ToolExecutor(registry, ctx, noPlugins);
    const fork = parent.fork();

    await parent.execute({ id: "1", name: "read", arguments: { p: "x" } });
    expect(readCalls).toBe(1);
    // Same args through the fork → served from the shared memo, handler not run.
    await fork.execute({ id: "2", name: "read", arguments: { p: "x" } });
    expect(readCalls).toBe(1);
    // A mutation through the fork must clear the shared cache.
    await fork.execute({ id: "3", name: "mutate", arguments: {} });
    await parent.execute({ id: "4", name: "read", arguments: { p: "x" } });
    expect(readCalls).toBe(2);
  });
});
