/**
 * W1.9: повторный вызов определяется канонической подписью — порядок ключей и
 * `./path` vs `path` не делают вызов «новым» (§1.9 аудита).
 */
import { describe, expect, it } from "vitest";
import { createLoopState } from "../../src/core/agent/loop-state";
import { detectRepeatedToolCall } from "../../src/core/agent/loop-repeat";

function call(name: string, args: Record<string, unknown>) {
  return { id: "t1", name, arguments: args };
}

describe("repetition signature", () => {
  it("treats a reordered-keys call as the same call", () => {
    const state = createLoopState();
    const first = detectRepeatedToolCall(
      state,
      [call("read_file", { path: "a.ts", offset: 1 })],
      false,
    );
    expect(first.repeated).toBe(false);
    const second = detectRepeatedToolCall(
      state,
      [call("read_file", { offset: 1, path: "a.ts" })],
      false,
    );
    expect(second.repeated).toBe(true);
  });

  it("treats ./path and path as the same call", () => {
    const state = createLoopState();
    detectRepeatedToolCall(state, [call("read_file", { path: "a.ts" })], false);
    const same = detectRepeatedToolCall(state, [call("read_file", { path: "./a.ts" })], false);
    expect(same.repeated).toBe(true);
  });

  it("does not stop while the call genuinely changes", () => {
    const state = createLoopState();
    for (let i = 0; i < 10; i++) {
      const r = detectRepeatedToolCall(state, [call("read_file", { path: `a${i}.ts` })], false);
      expect(r.repeated).toBe(false);
      expect(r.stop).toBe(false);
    }
  });
});
