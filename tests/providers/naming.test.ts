import { describe, expect, it } from "bun:test";
import { providerEntryName, providerNameTaken } from "../../src/modules/providers/naming";

const entries = [
  { type: "openai-compat", label: "local" },
  { type: "openrouter", label: "or" },
];

describe("provider naming", () => {
  it("names an entry by label, falling back to type", () => {
    expect(providerEntryName({ type: "openai", label: "cloud" })).toBe("cloud");
    expect(providerEntryName({ type: "openai" })).toBe("openai");
  });

  it("rejects a name already used by a label", () => {
    expect(providerNameTaken(entries, "local")).toBe(true);
    expect(providerNameTaken(entries, "free")).toBe(false);
  });

  it("rejects a name that is a bare type of a differently-labelled entry", () => {
    // `openai-compat` names `local` only via its type → ambiguous.
    expect(providerNameTaken(entries, "openai-compat")).toBe(true);
  });

  it("lets an edit keep its own name via exceptName", () => {
    expect(providerNameTaken(entries, "local", "local")).toBe(false);
    expect(providerNameTaken(entries, "or", "local")).toBe(true);
  });

  it("allows a label that equals its own type", () => {
    const solo = [{ type: "openai-compat", label: "openai-compat" }];
    expect(providerNameTaken(solo, "openai-compat")).toBe(true); // still taken by itself
    expect(providerNameTaken(solo, "openai-compat", "openai-compat")).toBe(false);
  });
});
