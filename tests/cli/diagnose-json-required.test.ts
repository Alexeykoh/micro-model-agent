// Guard: `mma session diagnose` без `--json` — это отказ, а не успех.
//
// Регресс из стресс-теста (волна 17): команда печатала «session diagnose
// требует --json», возвращала EXIT=0 и ничего не разбирала; флаг при этом не
// был виден в `--help` (`session diagnose --help` показывал только `-h`).
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();

function run(args: string[], configDir: string) {
  return spawnSync(process.execPath, ["run", "src/cli/main.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MMA_CONFIG_DIR: configDir, MMA_LOCALE: "ru", NO_COLOR: "1" },
    timeout: 60_000,
  });
}

describe("session diagnose: --json обязателен и виден в help", () => {
  it("без --json завершается кодом 1 и пишет причину в stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-diagnose-"));
    try {
      const res = run(["session", "diagnose", "ses_deadbeef"], dir);

      expect(res.status).toBe(1);
      expect(String(res.stderr)).toContain("--json");
      // stdout остаётся чистым: причина уходит в stderr.
      expect(String(res.stdout)).not.toContain("--json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--help рассказывает про обязательный флаг", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-diagnose-"));
    try {
      const res = run(["session", "diagnose", "--help"], dir);

      expect(res.status).toBe(0);
      expect(String(res.stdout)).toContain("--json");
      expect(String(res.stdout)).toMatch(/session diagnose/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
