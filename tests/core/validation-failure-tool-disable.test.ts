// Ошибки валидации/политики не должны отключать рабочий тул.
import { describe, it, expect } from "vitest";
import { recordRepeatedToolFailure } from "../../src/core/agent/failure-memory";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { ToolCall } from "../../src/core/types";
import type { ToolResult } from "../../src/tools/types";

const deps = {
  contextManager: { addMessage: () => undefined } as never,
  logger: { diagnostic: () => undefined } as never,
};
const call = (name: string): ToolCall => ({ id: "1", name, arguments: {} }) as ToolCall;
const blocked = (output: string): ToolResult => ({ success: false, output });

function failThree(name: string, result: ToolResult) {
  const state = createLoopState();
  for (let i = 0; i < 3; i++) recordRepeatedToolFailure(state, call(name), result, deps);
  return state;
}

describe("accounting: validation failures do not disable tools", () => {
  it("security-blocked bash commands keep bash available", () => {
    const state = failThree(
      "bash",
      blocked(
        '[SECURITY BLOCKED] Command is not allowed: Operator ">" is not allowed\nHint: run one plain command per tool call.',
      ),
    );
    expect(state.disabledTools.has("bash")).toBe(false);
    expect(state.toolFailureCounts.get("bash")?.count ?? 0).toBe(0);
  });

  it("bad process id does not disable process_wait", () => {
    const state = failThree("process_wait", blocked("Process not found: __p6_8"));
    expect(state.disabledTools.has("process_wait")).toBe(false);
  });

  it("non-retryable errorMeta is excluded too", () => {
    const state = failThree("bash", {
      success: false,
      output: "command failed",
      errorMeta: { code: "BAD_ARGS", retryable: false },
    });
    expect(state.disabledTools.has("bash")).toBe(false);
  });

  it("real environment failures still disable the tool", () => {
    const state = failThree("browser", blocked("bridge-server.mjs not found: ENOENT"));
    expect(state.disabledTools.has("browser")).toBe(true);
  });
});
