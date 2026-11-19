/**
 * A6: `critical` с перечисленными жалобами без улики понижается до `concern`
 * (жалоба доходит до модели советом, но не открывает repair-цикл).
 */
import { describe, it, expect } from "vitest";
import { withProvenance } from "../../../src/modules/critic/provenance";
import type { CriticVerdict } from "../../../src/modules/critic/types";

function verdict(over: Partial<CriticVerdict> = {}): CriticVerdict {
  return {
    status: "critical",
    summary: "numbers look wrong",
    issues: [
      { severity: "critical", claim: "index says 1487", problem: "on disk it is >4000" },
    ],
    ...over,
  };
}

describe("critic provenance", () => {
  it("keeps critical when a critical issue carries evidence", () => {
    const v = verdict({
      issues: [
        {
          severity: "critical",
          claim: "index says 1487",
          problem: "on disk it is >4000",
          evidence: "bash: (Get-ChildItem -Recurse).Count => 4021",
        },
      ],
    });
    const res = withProvenance(v);
    expect(res.verdict.status).toBe("critical");
    expect(res.downgraded).toBeUndefined();
  });

  it("downgrades critical to concern when no critical issue has evidence", () => {
    const res = withProvenance(verdict());
    expect(res.verdict.status).toBe("concern");
    expect(res.downgraded).toBe("no_evidence");
    expect(res.verdict.issues.every((i) => i.severity === "concern")).toBe(true);
    expect(res.verdict.summary).toBe("numbers look wrong");
  });

  it("leaves critical without listed issues unchanged", () => {
    const res = withProvenance(verdict({ issues: [] }));
    expect(res.verdict.status).toBe("critical");
    expect(res.downgraded).toBeUndefined();
  });

  it("does not touch ok/concern", () => {
    expect(withProvenance(verdict({ status: "ok", issues: [] })).verdict.status).toBe("ok");
    expect(withProvenance(verdict({ status: "concern" })).downgraded).toBeUndefined();
  });
});
