// RCV-2/3/4/5: recovery-сабагент исполняет исправленный вызов через execute.
import { describe, it, expect } from "vitest";
import { createRecoveryGate } from "../../src/modules/recovery/gate";
import type { RecoveryProposal } from "../../src/modules/recovery/client";
import type { ToolCall } from "../../src/core/types";
import type { ToolResult } from "../../src/tools/types";
import { RECOVERY_MAX_PER_TURN } from "../../src/modules/recovery/constants";

const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: `c-${name}`, name, arguments: args }) as ToolCall;
const validationFail = (output: string): ToolResult => ({ success: false, output });
const ok = (output = "ok"): ToolResult => ({ success: true, output });

const logger = { diagnostic: () => undefined };

function setup(proposal: RecoveryProposal | null, events?: string[]) {
  const executed: ToolCall[] = [];
  const client = { propose: async (): Promise<RecoveryProposal | null> => proposal };
  const gate = createRecoveryGate({
    client,
    availableTools: ["bash", "plan"],
    logger,
    slog: events
      ? { logDiagnosticEvent: (event: string) => events.push(event) }
      : undefined,
    execute: async (c) => {
      executed.push(c);
      return ok("corrected");
    },
  });
  return { gate, executed };
}

describe("recovery gate", () => {
  it("ignores successes and non-validation failures", async () => {
    const { gate, executed } = setup({ call: { name: "bash", arguments: {} }, reason: "x" });
    expect(await gate.maybeRecover(call("bash"), ok(), "task")).toBeNull();
    expect(await gate.maybeRecover(call("bash"), validationFail("ENOENT"), "task")).toBeNull();
    expect(executed).toHaveLength(0);
  });

  it("waits for the 2nd validation failure, then executes the corrected call", async () => {
    const corrected: RecoveryProposal = {
      call: { name: "bash", arguments: { command: "npm -v", workdir: "." } },
      reason: "use workdir",
    };
    const { gate, executed } = setup(corrected);
    const bad = validationFail('[SECURITY BLOCKED] Operator ">" is not allowed');
    expect(await gate.maybeRecover(call("bash", { command: "npm > out" }), bad, "task")).toBeNull();
    const outcome = await gate.maybeRecover(call("bash", { command: "npm > out" }), bad, "task");
    expect(outcome?.output).toBe("corrected");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.name).toBe("bash");
    expect(executed[0]!.arguments.workdir).toBe(".");
  });

  it("is bounded per turn", async () => {
    const { gate, executed } = setup({ call: { name: "bash", arguments: {} }, reason: "x" });
    const bad = validationFail("[SECURITY BLOCKED] blocked");
    for (let i = 0; i < RECOVERY_MAX_PER_TURN + 3; i++) {
      await gate.maybeRecover(call(`bash${i % 2}`), bad, "task");
    }
    expect(gate.total()).toBeLessThanOrEqual(RECOVERY_MAX_PER_TURN);
    expect(executed.length).toBeLessThanOrEqual(RECOVERY_MAX_PER_TURN);
  });

  it("fails open when proposal is null or execution throws", async () => {
    const { gate } = setup(null);
    const bad = validationFail("[SECURITY BLOCKED] blocked");
    await gate.maybeRecover(call("bash"), bad, "task");
    expect(await gate.maybeRecover(call("bash"), bad, "task")).toBeNull();

    const throwing = createRecoveryGate({
      client: { propose: async (): Promise<RecoveryProposal> => ({ call: { name: "bash", arguments: {} }, reason: "x" }) },
      availableTools: ["bash"],
      logger,
      execute: async () => { throw new Error("boom"); },
    });
    await throwing.maybeRecover(call("bash"), bad, "task");
    expect(await throwing.maybeRecover(call("bash"), bad, "task")).toBeNull();
  });

  it("emits recovery_attempt and recovery_result diagnostics", async () => {
    const events: string[] = [];
    const { gate } = setup(null, events);
    const bad = validationFail("[SECURITY BLOCKED] blocked");
    await gate.maybeRecover(call("bash"), bad, "task");
    await gate.maybeRecover(call("bash"), bad, "task");
    expect(events).toContain("recovery_attempt");
    expect(events).toContain("recovery_result");
  });
});
