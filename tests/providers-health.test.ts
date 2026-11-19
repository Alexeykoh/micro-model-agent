import { describe, it, expect } from "vitest";
import {
  probeProviders,
  type ProbeTarget,
} from "../src/modules/providers/health";

function target(name: string, behavior: () => Promise<string[]>): ProbeTarget {
  return { name, listModels: behavior };
}

describe("probeProviders", () => {
  it("reports ok with elapsed ms on success", async () => {
    const results = await probeProviders([
      target("a", async () => ["m1", "m2"]),
    ]);
    expect(results[0].name).toBe("a");
    expect(results[0].ok).toBe(true);
    expect(results[0].models).toBe(2);
    expect(results[0].error).toBeUndefined();
    expect(results[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("reports failure with error message", async () => {
    const results = await probeProviders([
      target("bad", async () => {
        throw new Error("connection refused");
      }),
    ]);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("connection refused");
    expect(results[0].models).toBe(0);
  });

  it("times out a hanging probe", async () => {
    const results = await probeProviders(
      [
        target("slow", () => new Promise<string[]>((resolve) => setTimeout(resolve, 5000))),
      ],
      { timeoutMs: 30 },
    );
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/timeout/i);
  }, 10000);

  it("probes all targets concurrently and preserves input order", async () => {
    const results = await probeProviders(
      [
        target("fast", async () => ["x"]),
        target("slow", async () => {
          await new Promise((r) => setTimeout(r, 20));
          return ["y"];
        }),
        target("dead", async () => {
          throw new Error("down");
        }),
      ],
      { timeoutMs: 2000 },
    );
    expect(results.map((r) => r.name)).toEqual(["fast", "slow", "dead"]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
  });

  it("empty input yields empty output", async () => {
    expect(await probeProviders([])).toEqual([]);
  });
});
