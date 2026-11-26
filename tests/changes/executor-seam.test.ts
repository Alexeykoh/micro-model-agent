import { describe, expect, it } from "bun:test";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { FileChangesPort, ToolContext, ToolDefinition } from "../../src/tools/types";

/** Пишем только исход снапшота: commit (`after`) или отмену (`cancel`). */
function stubPort(): { port: FileChangesPort; events: string[] } {
  const events: string[] = [];
  const port: FileChangesPort = {
    beginTurn: () => {},
    captureBefore: () => { events.push("before"); },
    captureAfter: (_callId, success) => { events.push(`after:${success}`); },
    cancel: () => { events.push("cancel"); },
    clear: () => {},
    list: () => [],
    undo: () => ({ ok: false, message: "", items: [] }),
  };
  return { port, events };
}

async function run(
  port: FileChangesPort,
  handler: ToolDefinition["handler"],
  plugins: Array<{ name: string; onBeforeTool?: () => false }> = [],
) {
  const registry = new ToolRegistry();
  registry.register({
    name: "probe", description: "", parameters: {}, security: { caps: [] }, handler,
  }, "test");
  const config = structuredClone(DEFAULTS) as AppConfig;
  const ctx = {
    config, baseDir: process.cwd(), activeToolTags: [], sessionId: "s1", fileChanges: port,
    logger: { debug() {}, info() {}, warn() {}, error() {}, logToolCall() {}, logToolOutput() {} } as never,
  } as unknown as ToolContext;
  return new ToolExecutor(registry, ctx, { getAllPlugins: () => plugins } as never)
    .execute({ id: "c1", name: "probe", arguments: {} });
}

describe("ToolExecutor capture seam", () => {
  it("commits a snapshot on success", async () => {
    const { port, events } = stubPort();
    const result = await run(port, async () => ({ success: true, output: "ok" }));
    expect(result.success).toBe(true);
    expect(events).toEqual(["before", "after:true"]);
  });

  it("commits a failed snapshot when the handler throws", async () => {
    const { port, events } = stubPort();
    const result = await run(port, async () => { throw new Error("boom"); });
    expect(result.success).toBe(false);
    expect(events).toEqual(["before", "after:false"]);
  });

  it("cancels the snapshot when a plugin blocks the call", async () => {
    const { port, events } = stubPort();
    const result = await run(
      port,
      async () => ({ success: true, output: "ok" }),
      [{ name: "blocker", onBeforeTool: () => false }],
    );
    expect(result.blocked).toBe(true);
    expect(events).toEqual(["before", "cancel"]);
  });
});
