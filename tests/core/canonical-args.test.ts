import { describe, it, expect } from "vitest";
import { canonicalArgsKey } from "../../src/core/agent/canonical-args";

describe("canonicalArgsKey", () => {
  it("is stable across object key order", () => {
    expect(canonicalArgsKey("read_file", { path: "a.ts", offset: 10 })).toBe(
      canonicalArgsKey("read_file", { offset: 10, path: "a.ts" }),
    );
  });

  it("differs for different tools or different args", () => {
    expect(canonicalArgsKey("read_file", { path: "a.ts" })).not.toBe(
      canonicalArgsKey("grep", { path: "a.ts" }),
    );
    expect(canonicalArgsKey("read_file", { path: "a.ts" })).not.toBe(
      canonicalArgsKey("read_file", { path: "a.ts", offset: 1 }),
    );
  });

  it("normalizes path-bearing values (separators, ./-prefix, trailing slash)", () => {
    expect(canonicalArgsKey("read_file", { path: "src\\a.ts" })).toBe(
      canonicalArgsKey("read_file", { path: "src/a.ts" }),
    );
    expect(canonicalArgsKey("read_file", { path: "./a.ts" })).toBe(
      canonicalArgsKey("read_file", { path: "a.ts" }),
    );
    expect(canonicalArgsKey("grep", { path: "src/", pattern: "x" })).toBe(
      canonicalArgsKey("grep", { path: "src", pattern: "x" }),
    );
    expect(canonicalArgsKey("read_file", { path: "a.ts", offset: 1 })).not.toBe(
      canonicalArgsKey("read_file", { path: "a.ts", offset: 2 }),
    );
  });

  it("does NOT normalize non-path string values (regex patterns keep backslashes)", () => {
    const key = canonicalArgsKey("grep", { pattern: "a\\.b" });
    expect(key).toBe(`grep::{"pattern":${JSON.stringify("a\\.b")}}`);
  });

  it("does not normalize strings nested under a path-named key", () => {
    expect(canonicalArgsKey("x", { file: { content: "a\\b" } })).toBe(
      'x::{"file":{"content":"a\\\\b"}}',
    );
  });
});
