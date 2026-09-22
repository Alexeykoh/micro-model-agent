import { describe, it, expect } from "vitest";
import {
  resolveModelCapabilities,
  DEFAULT_MODEL_CAPABILITIES,
} from "../src/modules/providers/capabilities";

describe("resolveModelCapabilities", () => {
  const preset = { vision: true, tools: true };

  it("uses the preset when no probe or override is present", () => {
    expect(resolveModelCapabilities(preset, undefined, undefined)).toEqual({
      vision: true,
      tools: true,
    });
  });

  it("falls back to conservative defaults without a preset", () => {
    expect(resolveModelCapabilities(undefined, undefined, undefined)).toEqual(
      DEFAULT_MODEL_CAPABILITIES,
    );
  });

  it("lets the live probe override the preset", () => {
    expect(
      resolveModelCapabilities({ vision: false, tools: true }, { vision: true }, undefined),
    ).toEqual({ vision: true, tools: true });
  });

  it("lets the config override win over both probe and preset", () => {
    expect(
      resolveModelCapabilities(preset, { vision: true, tools: true }, { vision: false }),
    ).toEqual({ vision: false, tools: true });
  });

  it("only overrides the fields present in the probe", () => {
    expect(
      resolveModelCapabilities({ vision: true, tools: false }, { tools: true }, undefined),
    ).toEqual({ vision: true, tools: true });
  });

  it("does not mutate the preset or override objects", () => {
    const override = { vision: false };
    const out = resolveModelCapabilities(preset, undefined, override);
    out.vision = true;
    expect(preset.vision).toBe(true);
    expect(override.vision).toBe(false);
  });
});
