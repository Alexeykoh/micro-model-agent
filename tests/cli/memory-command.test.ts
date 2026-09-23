import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryStore } from "../../src/modules/memory/store";
import { applyMemoryCommand } from "../../src/cli/onboarding-commands";
import { t } from "../../src/i18n/index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-mem-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applyMemoryCommand", () => {
  it("sets and gets a preference", () => {
    const store = new MemoryStore(dir);
    applyMemoryCommand(store, ["set", "language", "ru"]);
    expect(store.getPreferences().language).toBe("ru");
  });
  it("unsets a preference", () => {
    const store = new MemoryStore(dir);
    store.setPreference("language", "ru");
    applyMemoryCommand(store, ["unset", "language"]);
    expect(store.getPreferences().language).toBeUndefined();
  });
  it("forgets an entry by index", () => {
    const store = new MemoryStore(dir);
    store.append("facts", "one");
    store.append("facts", "two");
    expect(applyMemoryCommand(store, ["forget", "facts", "1"]).length).toBe(1);
    expect(store.read("facts")).not.toContain("one");
    expect(store.read("facts")).toContain("two");
  });
  it("forgets a multi-line rule block entirely", () => {
    const store = new MemoryStore(dir);
    store.appendRule("errors", "PATTERN_TOKEN", "CAUSE_TOKEN", "SOLUTION_TOKEN");
    expect(store.read("errors")).toContain("PATTERN_TOKEN");
    expect(store.read("errors")).toContain("CAUSE_TOKEN");
    expect(store.read("errors")).toContain("SOLUTION_TOKEN");
    applyMemoryCommand(store, ["forget", "errors", "1"]);
    expect(store.read("errors")).not.toContain("PATTERN_TOKEN");
    expect(store.read("errors")).not.toContain("CAUSE_TOKEN");
    expect(store.read("errors")).not.toContain("SOLUTION_TOKEN");
  });
  it("find with an empty query returns usage", () => {
    const store = new MemoryStore(dir);
    store.append("facts", "one");
    expect(applyMemoryCommand(store, ["find"])).toEqual([t("repl.memory_usage")]);
  });
  it("out-of-range forget returns the entry-not-found message", () => {
    const store = new MemoryStore(dir);
    const lines = applyMemoryCommand(store, ["forget", "facts", "9"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(t("repl.memory_entry_not_found", { category: "facts", n: "9" }));
  });
  it("overview prints absolute indices for shown entries", () => {
    const store = new MemoryStore(dir);
    store.append("facts", "one");
    store.append("facts", "two");
    const out = applyMemoryCommand(store, []).join("\n");
    expect(out).toContain("[1] -");
    expect(out).toContain("[2] -");
  });
});
