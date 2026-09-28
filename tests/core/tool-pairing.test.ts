import { describe, it, expect } from "vitest";
import { repairToolCallPairing, UNRESOLVED_TOOL_RESULT } from "../../src/core/agent/tool-pairing";
import type { Message } from "../../src/modules/context/manager";

const asst = (ids: string[], content = ""): Message => ({
  role: "assistant",
  content,
  tool_calls: ids.map((id) => ({
    id,
    type: "function",
    function: { name: `tool_${id}`, arguments: "{}" },
  })),
});

const toolMsg = (id: string, content = "ok"): Message => ({
  role: "tool",
  content,
  name: `tool_${id}`,
  tool_call_id: id,
});

/** Инвариант контракта: assistant(tool_calls) сразу за которым — непрерывный tool-блок на все id. */
function assertValidPairing(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const declared = m.tool_calls.map((tc) => tc.id);
    let j = i + 1;
    const answered = new Set<string>();
    while (j < messages.length && messages[j].role === "tool") {
      const id = messages[j].tool_call_id;
      if (id) answered.add(id);
      j++;
    }
    for (const id of declared) {
      expect(answered.has(id), `call ${id} must be answered by a contiguous tool message`).toBe(true);
    }
  }
}

describe("repairToolCallPairing", () => {
  it("keeps a valid sequence unchanged", () => {
    const input: Message[] = [
      { role: "user", content: "hi" },
      asst(["A", "B"]),
      toolMsg("A"),
      toolMsg("B"),
      { role: "user", content: "next" },
    ];
    const out = repairToolCallPairing(input);
    expect(out).toEqual(input);
    assertValidPairing(out);
  });

  it("closes a run interleaved with a user message (auto-advance mid-batch)", () => {
    // assistant(A,B) -> tool A -> user(auto-advance) -> tool B   (реальный баг)
    const out = repairToolCallPairing([
      asst(["A", "B"]),
      toolMsg("A"),
      { role: "user", content: "<system-summary>step done</system-summary>" },
      toolMsg("B"),
    ]);
    assertValidPairing(out);
    expect(out[0]).toEqual(asst(["A", "B"]));
    expect(out[1]).toEqual(toolMsg("A"));
    expect(out[2].role).toBe("tool");
    expect(out[2].tool_call_id).toBe("B");
    expect(out[2].content).toBe(UNRESOLVED_TOOL_RESULT);
    // вклинившийся user остаётся после tool-блока
    expect(out[3]).toMatchObject({ role: "user" });
    // настоящий tool B отброшен как осиротевший
    expect(out.filter((m) => m.tool_call_id === "B")).toHaveLength(1);
  });

  it("closes pending calls before an interrupting user message", () => {
    const out = repairToolCallPairing([
      asst(["A", "B"]),
      { role: "user", content: "stop" },
      toolMsg("A"),
      toolMsg("B"),
    ]);
    assertValidPairing(out);
    expect(out[0]).toEqual(asst(["A", "B"]));
    expect(out[1].role).toBe("tool");
    expect(out[2].role).toBe("tool");
    expect(out[3]).toMatchObject({ role: "user", content: "stop" });
  });

  it("drops orphaned tool messages with no declaring assistant", () => {
    const out = repairToolCallPairing([
      { role: "user", content: "hi" },
      toolMsg("X"),
      { role: "assistant", content: "answer" },
    ]);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    assertValidPairing(out);
  });

  it("merges consecutive assistant(tool_calls) messages", () => {
    const out = repairToolCallPairing([asst(["A"]), asst(["B"]), toolMsg("A"), toolMsg("B")]);
    assertValidPairing(out);
    expect(out).toHaveLength(3);
    expect(out[0].tool_calls?.map((tc) => tc.id)).toEqual(["A", "B"]);
  });

  it("does not mutate the input messages", () => {
    const input: Message[] = [asst(["A"]), asst(["B"])];
    const snapshot = JSON.stringify(input);
    repairToolCallPairing(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is idempotent on already-repaired input", () => {
    const once = repairToolCallPairing([asst(["A", "B"]), toolMsg("A"), { role: "user", content: "x" }, toolMsg("B")]);
    const twice = repairToolCallPairing(once);
    expect(twice).toEqual(once);
  });
});
