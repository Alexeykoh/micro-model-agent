import { describe, it, expect } from "vitest";
import { isDevEntryPath } from "../src/modules/updater/dev-detect";

describe("isDevEntryPath", () => {
  it("treats TypeScript entries as dev runs", () => {
    expect(isDevEntryPath("E:/projects/micro-models-agent/src/cli/main.ts")).toBe(true);
    expect(isDevEntryPath("/home/u/repo/src/cli/main.tsx")).toBe(true);
    expect(isDevEntryPath("file:///x/main.mts")).toBe(true);
    expect(isDevEntryPath("/x/main.cts")).toBe(true);
  });

  it("treats the bundled/installed entry as a production run", () => {
    expect(
      isDevEntryPath("/usr/lib/node_modules/micro-models-agent/dist/main.js"),
    ).toBe(false);
    expect(isDevEntryPath("C:\\Users\\u\\AppData\\Roaming\\npm\\mma.cmd")).toBe(false);
  });

  it("ignores query/hash suffixes", () => {
    expect(isDevEntryPath("/x/main.ts?t=123")).toBe(true);
    expect(isDevEntryPath("/x/main.js#frag")).toBe(false);
  });
});
