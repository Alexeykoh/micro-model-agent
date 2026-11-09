// Guard: read-only CLI-команда не предупреждает о переполнении системного промпта.
//
// bootstrap всегда строит prompt-блоки и делает dry-run; для команд, где агент
// не запускается (config show, session list, doctor, plugins list), «будет
// суммаризован перед первым запуском» — ложь: запуска не будет. Варнинг на
// stderr шумит и путает («first run» без какого-либо run).
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("read-only CLI: нет стартового варнинга переполнения промпта", () => {
  it("`config show` не печатает Startup check на stderr", () => {
    dir = mkdtempSync(join(tmpdir(), "mma-readonly-overflow-"));
    const out = runCli(["config", "show"]);

    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("Startup check");
  });

  it("`plugins list` не печатает Startup check на stderr", () => {
    dir = mkdtempSync(join(tmpdir(), "mma-readonly-overflow-"));
    const out = runCli(["plugins", "list"]);

    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("Startup check");
  });

  it("`doctor` не печатает Startup check на stderr", () => {
    dir = mkdtempSync(join(tmpdir(), "mma-readonly-overflow-"));
    const out = runCli(["doctor"]);

    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).not.toContain("Startup check");
  });
});
