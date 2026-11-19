/**
 * A5: форк исполнителя с собственным менеджером плагинов (субагент) не должен
 * двигать состояние плагинов родителя — иначе детектор застревания и счётчики
 * флейлинга считают падения ребёнка падениями родителя (сессия ses_mvzp8cuk:
 * «bash упал 15 раз» у хода с двумя вызовами).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import { PluginManager } from "../../src/modules/plugins/manager";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";

function makeCtx(baseDir: string): ToolContext {
  return {
    config: {},
    baseDir,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      logToolCall: vi.fn(),
      logToolOutput: vi.fn(),
    },
  } as unknown as ToolContext;
}

function registerEcho(registry: ToolRegistry): void {
  const def: ToolDefinition = {
    name: "t",
    description: "d",
    parameters: { type: "object", properties: {} },
    security: { caps: [{ fs: "read" }] },
    handler: async () => ({ success: true, output: "ok" }),
  };
  registry.register(def, "core");
}

describe("ToolExecutor.fork: изоляция менеджера плагинов (A5)", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "mma-fork-pm-"));
  const registry = new ToolRegistry();
  registerEcho(registry);

  it("хуки плагинов форка не доходят до родителя", async () => {
    const parentHook = vi.fn();
    const childHook = vi.fn();
    const parentPm = new PluginManager();
    parentPm.register(
      { name: "parent", onBeforeTool: parentHook } as unknown as Parameters<
        PluginManager["register"]
      >[0],
      "builtin",
    );
    const childPm = new PluginManager();
    childPm.register(
      { name: "child", onBeforeTool: childHook } as unknown as Parameters<
        PluginManager["register"]
      >[0],
      "builtin",
    );

    const parent = new ToolExecutor(registry, makeCtx(baseDir), parentPm);
    const child = parent.fork(childPm);
    const call = { id: "c1", name: "t", arguments: {} };
    await parent.execute(call);
    await child.execute(call);

    expect(parentHook).toHaveBeenCalledOnce();
    expect(childHook).toHaveBeenCalledOnce();
  });
});
