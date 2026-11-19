// Guard: «плагин не найден» — это отказ, а не успех.
//
// Регресс из стресс-теста (волна 18): `mma plugins disable nope-plugin` печатал
// «Плагин не найден», но возвращал EXIT=0 — в отличие от `provider use` и
// `session delete`, где код 1. То же было у `plugins show <неизвестный>`.
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

describe("plugins: неизвестное имя — код возврата 1", () => {
  it("disable неизвестного плагина", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-plugins-"));
    try {
      const res = run(["plugins", "disable", "nope-plugin"], dir);

      expect(res.status).toBe(1);
      expect(String(res.stderr)).toMatch(/nope-plugin/);
      // Диагностика не попадает в stdout.
      expect(String(res.stdout)).not.toMatch(/nope-plugin/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("show неизвестного плагина", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-plugins-"));
    try {
      const res = run(["plugins", "show", "nope-plugin"], dir);

      expect(res.status).toBe(1);
      expect(String(res.stderr)).toMatch(/nope-plugin/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
