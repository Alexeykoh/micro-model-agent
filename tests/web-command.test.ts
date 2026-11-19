import { describe, it, expect } from "vitest";
import { parsePort, webBootstrapArgs } from "../src/cli/web-command";

describe("parsePort", () => {
  it("treats missing/blank as 'random port'", () => {
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort("")).toBeUndefined();
    expect(parsePort("   ")).toBeUndefined();
  });

  it("accepts a valid integer port", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("65535")).toBe(65535);
  });

  it("rejects non-numeric and out-of-range values instead of falling back", () => {
    for (const raw of ["abc", "1.5", "0", "-1", "70000", "NaN", "12px"]) {
      expect(() => parsePort(raw)).toThrow(/invalid --port/);
    }
  });
});

describe("webBootstrapArgs", () => {
  it("forwards --no-agents-md to bootstrap", () => {
    expect(webBootstrapArgs({ projectDir: "/proj", noAgentsMd: true })).toEqual([
      undefined,
      "/proj",
      true,
      true,
    ]);
  });

  it("passes undefined for noAgentsMd when the flag is absent", () => {
    expect(webBootstrapArgs({ projectDir: "/proj" })[2]).toBeUndefined();
  });
});
