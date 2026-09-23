import { describe, it, expect } from "vitest";
import { preflightProvider } from "../../src/modules/providers/preflight";

describe("preflightProvider", () => {
  it("reports ok when a model responds", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => "ok" },
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
  });

  it("reports no-model when the probe returns empty", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => "" },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-model");
  });

  it("reports provider error", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => { throw new Error("ECONNREFUSED"); } },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unreachable");
  });

  it("reports timeout when the probe times out", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => { throw new Error("timeout after 3000ms"); } },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
  });

  it("reports unreachable for a non-ok HTTP response", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => { throw new Error("HTTP 401"); } },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unreachable");
  });

  it("reports a numeric non-negative duration", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => "ok" },
    );
    expect(typeof res.ms).toBe("number");
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });
});
