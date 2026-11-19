import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryStore } from "../../../src/modules/memory/store";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-mem-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MemoryStore quality gate", () => {
  it("rejects garbage without touching the file", () => {
    const store = new MemoryStore(dir);
    const before = readFileSync(join(dir, "facts.md"), "utf-8");
    const r = store.append("facts", "-");
    expect(r.accepted).toBe(false);
    expect(readFileSync(join(dir, "facts.md"), "utf-8")).toBe(before);
  });

  it("writes a valid entry and rejects its duplicate", () => {
    const store = new MemoryStore(dir);
    const first = store.append("conventions", "always run the full test suite before merging");
    expect(first.accepted).toBe(true);
    const second = store.append("conventions", "always run the full test suite before merging");
    expect(second.accepted).toBe(false);
    expect(readFileSync(join(dir, "conventions.md"), "utf-8")).toContain(
      "always run the full test suite before merging",
    );
  });

  it("can be disabled explicitly", () => {
    const store = new MemoryStore(dir, { enabled: false });
    expect(store.append("facts", "-").accepted).toBe(true);
  });

  it("rejects a garbage rule and writes a valid one", () => {
    const store = new MemoryStore(dir);
    expect(store.appendRule("errors", "", "cause text", "solution text").accepted).toBe(false);
    expect(
      store.appendRule(
        "errors",
        "edit_file returns string not found",
        "the file changed since it was read",
        "read the file again before editing",
      ).accepted,
    ).toBe(true);
  });
});
