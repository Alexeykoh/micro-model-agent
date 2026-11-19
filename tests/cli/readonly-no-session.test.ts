// Guard (A-01): read-only CLI-команда не создаёт сессию.
//
// Регресс из стресс-теста (волна 1): `mma plugins list` вызывал bootstrap,
// который создавал пустую сессию; на реальном ~/.mma это запускало удаление
// десятков тысяч каталогов (97k) и падало EFAULT. Read-only команде сессия не
// нужна — она не должна появляться даже пустой.
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["run", "src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, MMA_CONFIG_DIR: dir, MMA_LSP_OFFLINE: "1" },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

describe("read-only CLI: сессия не создаётся", () => {
  it("`plugins list` оставляет каталог sessions пустым", () => {
    dir = mkdtempSync(join(tmpdir(), "mma-readonly-session-"));
    const out = runCli(["plugins", "list"]);

    expect(out.status, out.stderr).toBe(0);
    const sessions = join(dir, "sessions");
    const entries = existsSync(sessions)
      ? readdirSync(sessions, { withFileTypes: true }).filter((e) => e.isDirectory())
      : [];
    expect(entries.map((e) => e.name)).toEqual([]);
  });
});
