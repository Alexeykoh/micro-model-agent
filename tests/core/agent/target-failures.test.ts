// Guard: провалы тулов считаются по паре «тул + цель» и после порога дают
// структурированную директиву перечитать файл, а не ещё один общий нudge.
import { describe, it, expect } from "vitest";
import { createLoopState } from "../../../src/core/agent/loop-state-init";
import { recordToolTargetFailure } from "../../../src/core/agent/target-failures";
import type { ToolCall } from "../../../src/core/types";
import type { ToolResult } from "../../../src/tools/types";

function call(path: string): ToolCall {
  return { id: "c1", name: "edit_file", arguments: { path, old_string: "old" } } as ToolCall;
}
function fail(): ToolResult {
  return { success: false, output: "Project typecheck failed" };
}
function ok(): ToolResult {
  return { success: true, output: "ok" };
}

describe("эскалация провалов по цели", () => {
  it("третий провал одной цели даёт директиву read_file", () => {
    const state = createLoopState();
    expect(recordToolTargetFailure(state, call("src/a.ts"), fail())).toBeNull();
    expect(recordToolTargetFailure(state, call("src/a.ts"), fail())).toBeNull();
    const directive = recordToolTargetFailure(state, call("src/a.ts"), fail());
    expect(directive).toBeTruthy();
    expect(directive).toContain("read_file");
    expect(directive).toContain("src/a.ts");
    // Директива одноразовая.
    expect(recordToolTargetFailure(state, call("src/a.ts"), fail())).toBeNull();
  });

  it("успех обнуляет счётчик, но не повторяет директиву", () => {
    const state = createLoopState();
    for (let i = 0; i < 3; i++) recordToolTargetFailure(state, call("src/a.ts"), fail());
    recordToolTargetFailure(state, call("src/a.ts"), ok());
    expect(recordToolTargetFailure(state, call("src/a.ts"), fail())).toBeNull();
  });

  it("разные пути не делят счётчик", () => {
    const state = createLoopState();
    recordToolTargetFailure(state, call("src/a.ts"), fail());
    recordToolTargetFailure(state, call("src/b.ts"), fail());
    expect(recordToolTargetFailure(state, call("src/a.ts"), fail())).toBeNull();
  });
});
