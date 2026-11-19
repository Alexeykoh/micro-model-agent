import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { Diagnostic } from "../../src/output/types";
import type { ToolDefinition } from "../../src/tools/types";

const noPlugins = { getAllPlugins: () => [] } as any;

function throwingRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const tool: ToolDefinition = {
    name: "boom",
    description: "throws",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("handler exploded");
    },
  };
  registry.register(tool);
  return registry;
}

function makeCtx(): any {
  return {
    recursionDepth: 0,
    scope: undefined,
    sessionId: "s1",
    logger: { logToolCall: () => {}, logToolOutput: () => {}, debug: () => {}, warn: () => {} },
  };
}

/**
 * Gate W2 (INV-15): исключение хендлера не должно исчезать в `success:false`.
 * До правки сигнал эмитился только в `tool-batch-calls`, куда исключение уже
 * не долетало, поэтому документированный `tool_attempt` не срабатывал.
 */
describe("ToolExecutor: исключение хендлера оставляет tool_attempt", () => {
  it("пишет один сигнал с именем тула и причиной", async () => {
    const seen: Diagnostic[] = [];
    const executor = new ToolExecutor(throwingRegistry(), makeCtx(), noPlugins);
    executor.setDiagnosticSink((diag) => seen.push(diag));

    const result = await executor.execute({ id: "call-1", name: "boom", arguments: {} });

    expect(result.success).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      source: "tool:boom",
      operation: "tool.execute",
      kind: "failed",
      cause: "handler exploded",
      detail: { toolCallId: "call-1" },
    });
  });

  it("не пишет сигнал при содержательном отказе тула", async () => {
    const seen: Diagnostic[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "refuse",
      description: "refuses",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ success: false, output: "no" }),
    });
    const executor = new ToolExecutor(registry, makeCtx(), noPlugins);
    executor.setDiagnosticSink((diag) => seen.push(diag));

    await executor.execute({ id: "call-2", name: "refuse", arguments: {} });

    expect(seen).toEqual([]);
  });
});
