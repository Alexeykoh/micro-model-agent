import { describe, it, expect } from "vitest";
import { resolveProviderRef, providerEntryName } from "../../src/modules/providers/resolve-ref";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";

function cfg(): AppConfig {
  const c = structuredClone(DEFAULTS);
  c.provider.entries = [
    { type: "openai-compat", label: "local", baseUrl: "http://localhost:1234/v1" },
    { type: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-x" },
  ];
  return c;
}

describe("resolveProviderRef", () => {
  it("returns undefined for empty/whitespace refs (→ active provider)", () => {
    const c = cfg();
    expect(resolveProviderRef(c, undefined)).toBeUndefined();
    expect(resolveProviderRef(c, "")).toBeUndefined();
    expect(resolveProviderRef(c, "   ")).toBeUndefined();
  });

  it("passes a full ProviderConfig object through unchanged", () => {
    const c = cfg();
    const ref = { type: "openai", baseUrl: "https://api.openai.com/v1" };
    expect(resolveProviderRef(c, ref)).toBe(ref);
  });

  it("resolves a provider name to its entry", () => {
    const c = cfg();
    const resolved = resolveProviderRef(c, "local");
    expect(resolved?.type).toBe("openai-compat");
    expect(resolved?.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("falls back to type matching when the label is missing", () => {
    const c = cfg();
    const resolved = resolveProviderRef(c, "openrouter");
    expect(resolved?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("returns undefined for an unknown name", () => {
    const c = cfg();
    expect(resolveProviderRef(c, "nope")).toBeUndefined();
  });

  it("providerEntryName prefers the label", () => {
    expect(providerEntryName({ type: "openai-compat", label: "local", baseUrl: "x" })).toBe("local");
    expect(providerEntryName({ type: "openai-compat", baseUrl: "x" })).toBe("openai-compat");
  });
});
