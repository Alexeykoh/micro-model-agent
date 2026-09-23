import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryStore } from "../../src/modules/memory/store";
import { applyMemoryCommand } from "../../src/cli/onboarding-commands";

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
});
