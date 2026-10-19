import { describe, expect, it } from "vitest";
import type { SessionManager } from "../../src/modules/session/index";
import { egressDiagnosticSink } from "../../src/core/bootstrap/tool-context";
import { createGuard, EgressBlockedError } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { GuardDiagnostic } from "../../src/modules/security/data-policy/types";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";

const ctx: PolicyContext = { baseDir: "C:\\work\\proj", hostname: "DESKTOP-ABC123" };

/** Циклическая структура гарантированно переполняет стек в projectDeep. */
function circular(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

function guard(failClosed: boolean, diags: GuardDiagnostic[]) {
  return createGuard({
    config: { ...DEFAULT_DATA_POLICY, failClosed },
    target: { kind: "api", trusted: false },
    ctx,
    onDiagnostic: (d) => diags.push(d),
  });
}

describe("egress guard diagnostics (INV-15)", () => {
  it("fail-closed оставляет aborted с причиной", () => {
    const diags: GuardDiagnostic[] = [];
    expect(() => guard(true, diags).filterClient(circular())).toThrow(EgressBlockedError);
    expect(diags).toContainEqual(
      expect.objectContaining({ outcome: "aborted", operation: "filterClient", cause: expect.any(String) }),
    );
  });

  it("fail-open оставляет passed с причиной (не молчит)", () => {
    const diags: GuardDiagnostic[] = [];
    const payload = circular();
    expect(guard(false, diags).filterClient(payload)).toBe(payload);
    expect(diags).toContainEqual(
      expect.objectContaining({ outcome: "passed", operation: "filterClient", cause: expect.any(String) }),
    );
  });

  it("sink пишет egress_blocked / egress_degraded в лог сессии", () => {
    const entries: Array<{ type: string; cause?: string }> = [];
    const fake = {
      appendLog: (entry: { type: string; cause?: string }) => entries.push(entry),
    } as unknown as SessionManager;
    const sink = egressDiagnosticSink(fake);
    sink({ module: "security.data-policy", operation: "sanitizeChat", kind: "egress", outcome: "aborted", cause: "boom" });
    sink({ module: "security.data-policy", operation: "sanitizeChat", kind: "egress", outcome: "passed", cause: "soft" });
    sink({ module: "security.data-policy", operation: "sanitizeChat", kind: "egress", outcome: "redacted" });
    expect(entries.map((e) => e.type)).toEqual(["egress_blocked", "egress_degraded"]);
    expect(entries[0].cause).toBe("boom");
  });
});
