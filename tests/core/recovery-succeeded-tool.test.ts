// RCV-8: успешно отработавший тул не отключается до конца хода.
import { describe, it, expect } from "vitest";
import { recordRepeatedToolFailure } from "../../src/core/agent/failure-memory";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { ToolCall } from "../../src/core/types";
import type { ToolResult } from "../../src/tools/types";

const call = (name: string): ToolCall => ({ id: "1", name, arguments: {} }) as ToolCall;
const bad = (output: string): ToolResult => ({ success: false, output });
const deps = {
  contextManager: { addMessage: () => undefined },
  logger: { diagnostic: () => undefined },
};
const depsTyped = deps as Parameters<typeof recordRepeatedToolFailure>[3];

describe("RCV-8: succeeded tools stay available", () => {
  it("does not disable bash that already succeeded this turn", () => {
    const state = createLoopState();
    recordRepeatedToolFailure(state, call("bash"), { success: true, output: "npm -v" }, depsTyped);
    for (let i = 0; i < 5; i++) {
      recordRepeatedToolFailure(state, call("bash"), bad("'sleep' is not recognized"), depsTyped);
    }
    expect(state.succeededToolsThisTurn.has("bash")).toBe(true);
    expect(state.disabledTools.has("bash")).toBe(false);
  });

  it("still disables a tool that never succeeded", () => {
    const state = createLoopState();
    for (let i = 0; i < 3; i++) {
      recordRepeatedToolFailure(state, call("browser"), bad("bridge-server.mjs not found"), depsTyped);
    }
    expect(state.disabledTools.has("browser")).toBe(true);
  });
});
