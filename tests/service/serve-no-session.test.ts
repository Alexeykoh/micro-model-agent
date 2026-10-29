/**
 * Гвард S-06: `mma serve` не создаёт сессию на старте.
 *
 * Раньше bootstrap создавал пустую сессию (`messageCount: 0`) при каждом
 * запуске сервиса — тот же класс, что A-01. Контракт: сессии появляются только
 * через `POST /v1/sessions` (или для уже существующей сессии при сабмите
 * задачи); старт сервиса оставляет `sessions/` пустым.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, setSessionAutocreate } from "../../src/core/bootstrap";
import { sessionNeededFor } from "../../src/cli/command-scope";

let dir = "";

afterEach(() => {
  setSessionAutocreate(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** Каталоги сессий в конфиг-директории (пусто, если каталога ещё нет). */
function sessionDirs(root: string): string[] {
  const sessions = join(root, "sessions");
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

describe("S-06: serve does not create a session on start", () => {
  it("serve is not a session command (web/REPL still are)", () => {
    const names = new Set(["serve", "web", "meet", "agents", "plugins"]);
    expect(sessionNeededFor("serve", names)).toBe(false);
    expect(sessionNeededFor("web", names)).toBe(true);
    expect(sessionNeededFor("meet", names)).toBe(true);
    expect(sessionNeededFor(undefined, names)).toBe(true);
    expect(sessionNeededFor("plugins", names)).toBe(false);
  });

  it("serve bootstrap leaves 0 sessions; an explicit create adds exactly one", async () => {
    dir = mkdtempSync(join(tmpdir(), "mma-serve-no-session-"));
    // То, что делает cli/main.ts до parse() для `mma serve`.
    setSessionAutocreate(sessionNeededFor("serve", new Set(["serve"])));

    const { sessionManager } = await bootstrap(dir, dir, true, true);
    expect(sessionDirs(dir)).toEqual([]);
    expect(sessionManager.getActive()).toBeFalsy();
    expect(sessionManager.list()).toEqual([]);

    // Явный путь контракта — POST /v1/sessions (SessionManager.create).
    sessionManager.create("explicit");
    expect(sessionDirs(dir)).toHaveLength(1);
  }, 30_000);
});
