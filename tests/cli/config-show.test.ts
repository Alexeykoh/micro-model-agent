import { describe, expect, it } from "bun:test";
import { configForDisplay } from "../../src/cli/commands";

describe("configForDisplay", () => {
  const cfg = { provider: { apiKey: "sk-secret" }, model: "m" };

  it("redacts secrets by default", () => {
    expect((configForDisplay(cfg) as any).provider.apiKey).toBe("***");
  });

  it("reveals secrets with showSecrets", () => {
    expect((configForDisplay(cfg, true) as any).provider.apiKey).toBe("sk-secret");
  });
});
