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

  it("reports empty model list", async () => {
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
});
