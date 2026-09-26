import { describe, expect, it } from "bun:test";
import { activeProviderEndpoint } from "../../src/modules/providers/manager";
import type { ProviderConfig } from "../../src/config/types";

const FLAT = {
  type: "openai-compat",
  baseUrl: "http://localhost:1234/v1",
  apiKey: "not-needed",
};

// Mirrors a real multi-entry config: flat fields stale on localhost while the
// active entry is opencode-go.
function multiEntry(active: string): ProviderConfig {
  return {
    ...FLAT,
    active,
    entries: [
      { type: "openai-compat", label: "openai-compat", baseUrl: "http://localhost:1234/v1", apiKey: "not-needed" },
      { type: "opencode-go", label: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k" },
    ],
  };
}

describe("activeProviderEndpoint", () => {
  it("resolves the active entry by label, not the flat fields", () => {
    expect(activeProviderEndpoint(multiEntry("opencode-go"))).toEqual({
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "k",
      type: "opencode-go",
    });
  });

  it("matches by type when no label equals the active name", () => {
    const cfg = multiEntry("openai-compat");
    expect(activeProviderEndpoint(cfg).baseUrl).toBe("http://localhost:1234/v1");
  });

  it("falls back to the first entry for an unknown active name", () => {
    expect(activeProviderEndpoint(multiEntry("missing")).baseUrl).toBe(
      "http://localhost:1234/v1",
    );
  });

  it("falls back to the flat fields for legacy single-provider configs", () => {
    expect(activeProviderEndpoint({ ...FLAT })).toEqual({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "not-needed",
      type: "openai-compat",
    });
  });
});
