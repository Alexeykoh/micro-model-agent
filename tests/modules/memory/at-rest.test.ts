/**
 * Гибридная память at-rest: авто-записи агента шифруются на месте, ручные
 * строки и preferences.json остаются открытыми.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryStore } from "../../../src/modules/memory/store";
import { setMemoryEncryptor } from "../../../src/modules/memory/at-rest";
import { SessionFileEncryptor } from "../../../src/modules/security/session-encryption";

const CANARY = "CANARY5a1c9d";
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-mem-"));
  setMemoryEncryptor(
    new SessionFileEncryptor({
      enabled: true,
      encryptHistory: true,
      encryptSessionLog: true,
      keyPath: join(dir, ".key"),
    }),
  );
});

afterEach(() => {
  setMemoryEncryptor(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("память at-rest (гибрид)", () => {
  it("авто-запись агента не лежит открыто, но читается", () => {
    const store = new MemoryStore(dir);
    store.append("facts", `секрет ${CANARY} и телефон +7 999 123-45-67`);

    const raw = readFileSync(join(dir, "facts.md"), "utf8");
    expect(raw).not.toContain(CANARY);
    expect(raw).toContain("[enc]");

    const text = store.read("facts");
    expect(text).toContain(CANARY);
    expect(store.search(CANARY)).toHaveLength(1);
  });

  it("ручная строка пользователя остаётся открытой и видимой", () => {
    const store = new MemoryStore(dir);
    store.append("facts", `auto ${CANARY}`);
    writeFileSync(join(dir, "facts.md"), `${readFileSync(join(dir, "facts.md"), "utf8")}- ручная заметка\n`);

    const text = store.read("facts");
    expect(text).toContain("ручная заметка");
    expect(text).toContain(CANARY);
  });

  it("preferences.json не шифруется (правит человек)", () => {
    const store = new MemoryStore(dir);
    store.setPreference("theme", "dark");
    expect(readFileSync(join(dir, "preferences.json"), "utf8")).toContain("dark");
  });

  it("при выключенном шифровании запись открыта (контроль)", () => {
    setMemoryEncryptor(null);
    const store = new MemoryStore(dir);
    store.append("facts", `plain ${CANARY}`);
    expect(readFileSync(join(dir, "facts.md"), "utf8")).toContain(CANARY);
  });
});
