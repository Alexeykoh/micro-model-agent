import { describe, expect, it } from "vitest";
import { failoverDiagnostic } from "../../src/modules/providers/factory";

/**
 * Gate W1 (INV-15): успешный failover — не «норма», а смена исполнителя.
 * Разбор сессии должен видеть, с какого провайдера ушли и почему.
 */
describe("provider failover signal", () => {
  it("несёт источник, причину и пару from→to", () => {
    const diag = failoverDiagnostic("primary", "backup", new Error("HTTP 503"));
    expect(diag).toMatchObject({
      source: "module:providers",
      operation: "provider.failover",
      kind: "degraded",
      cause: "HTTP 503",
      recoverable: true,
      detail: { from: "primary", to: "backup" },
    });
  });
});
