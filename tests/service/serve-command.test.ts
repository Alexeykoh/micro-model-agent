import { describe, expect, it } from "vitest";
import { parseServePort, serveBootstrapArgs } from "../../src/cli/service-command";

describe("parseServePort", () => {
  it("treats undefined and empty as unset", () => {
    expect(parseServePort(undefined)).toBeUndefined();
    expect(parseServePort("")).toBeUndefined();
    expect(parseServePort("   ")).toBeUndefined();
  });

  it("accepts a valid integer", () => {
    expect(parseServePort("7331")).toBe(7331);
  });

  it("throws on non-integer and out-of-range values", () => {
    expect(() => parseServePort("abc")).toThrow();
    expect(() => parseServePort("0")).toThrow();
    expect(() => parseServePort("70000")).toThrow();
  });
});

describe("serveBootstrapArgs", () => {
  it("forwards projectDir and noAgentsMd with exitOnComplete", () => {
    expect(serveBootstrapArgs({ projectDir: "/x", noAgentsMd: true })).toEqual([
      undefined,
      "/x",
      true,
      true,
    ]);
  });
});
