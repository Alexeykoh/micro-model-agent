import { describe, it, expect, vi } from "vitest";
import { AuditGate } from "../../src/core/agent/audit-gate";
import { createLoopState } from "../../src/core/agent/loop-state";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    state: createLoopState(),
    iteration: 3,
    maxIterations: 20,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      diagnostic: vi.fn(),
    },
    contextManager: { addMessage: vi.fn() },
    slog: { logAudit: vi.fn(), logRetract: vi.fn() },
    ...overrides,
  } as any;
}

const incomplete = async () => ({
  passed: false,
  done: 1,
  total: 3,
  pendingSteps: ["step 2"],
  missingFiles: [] as string[],
  summary: "1/3 steps done",
});

describe("AuditGate", () => {
  it("returns null when no final audit is configured", async () => {
    const gate = new AuditGate(undefined);
    expect(await gate.evaluate(deps())).toBeNull();
  });

  it("emits retract on reject so clients drop the streamed draft", async () => {
    const gate = new AuditGate(incomplete);
    const onMeta = vi.fn();
    const verdict = await gate.evaluate(deps({ onMeta }));
    expect(verdict?.action).toBe("reject");
    expect(onMeta).toHaveBeenCalledWith(
      expect.any(String),
      "retract",
      expect.objectContaining({ source: "audit", iteration: expect.any(Number) }),
    );
  });

  it("logs a skipped test run even when the verdict is pass (INV-15)", async () => {
    const slog = { logAudit: vi.fn() };
    const gate = new AuditGate(async () => ({
      passed: true,
      done: 1,
      total: 1,
      pendingSteps: [] as string[],
      missingFiles: [] as string[],
      summary: "Task complete",
      testNote: "skipped: no file mutations this turn",
    }));

    const verdict = await gate.evaluate(deps({ slog }));

    expect(verdict?.action).toBe("pass");
    expect(slog.logAudit).toHaveBeenCalledWith(
      "Task complete",
      3,
      expect.any(Number),
      "skipped: no file mutations this turn",
    );
  });
});
