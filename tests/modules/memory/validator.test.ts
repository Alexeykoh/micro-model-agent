import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MemoryValidator } from "../../../src/modules/memory/validator";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-mem-val-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MemoryValidator", () => {
  it("rejects garbage fragments", () => {
    const v = new MemoryValidator(dir);
    for (const bad of ["-", "# heading", "**Summary**", "[x] done", "42", "a", "{}"]) {
      expect(v.validate("facts", bad).accepted, bad).toBe(false);
    }
  });

  it("requires length and meaningful words, but accepts preferences key=value", () => {
    const v = new MemoryValidator(dir);
    expect(v.validate("conventions", "short").accepted).toBe(false);
    expect(v.validate("conventions", "always run the tests before merge").accepted).toBe(true);
    expect(v.validate("preferences", "theme=dark").accepted).toBe(true);
    expect(v.validate("errors", "tool failed").accepted).toBe(false);
    expect(v.validate("errors", "write_file failed with ENOENT on Windows path").accepted).toBe(true);
  });

  it("rejects exact and near duplicates from the category file", () => {
    const path = join(dir, "conventions.md");
    writeFileSync(
      path,
      '# Conventions\n\n- **2026-11-03 10:00:00** - always run the full test suite before merging\n',
      "utf-8",
    );
    const v = new MemoryValidator(dir);
    expect(v.validate("conventions", "always run the full test suite before merging").accepted).toBe(
      false,
    );
    expect(
      v.validate("conventions", "always run the full test suite before merging a branch").accepted,
    ).toBe(false);
    expect(v.validate("conventions", "prefer small focused commits over large ones").accepted).toBe(
      true,
    );
  });

  it("validates rule fields and the whole entry", () => {
    const v = new MemoryValidator(dir);
    expect(v.validateRule("errors", "", "cause text", "solution text").accepted).toBe(false);
    expect(
      v.validateRule(
        "errors",
        "edit_file returns string not found",
        "the file changed since it was read",
        "read the file again before editing",
      ).accepted,
    ).toBe(true);
  });

  it("does not crash on a missing category file", () => {
    const v = new MemoryValidator(dir);
    expect(v.validate("decisions", "choose bun over node for the test runner").accepted).toBe(true);
  });
});
