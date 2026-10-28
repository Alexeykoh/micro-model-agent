// Guard: интерактивные команды в non-TTY — это отказ, а не «успех без работы».
//
// Регресс из стресс-теста (волна 17): `mma meet` и `mma agents init` в пайпе
// печатали «Эта команда требует интерактивного терминала», ничего не делали и
// завершались с кодом 0 — CI/скрипт считал знакомство/AGENTS.md выполненными.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-onboarding-"));
  // Непустой домен-конфиг: иначе запустится визард первого старта.
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "core.json"), "{}\n", "utf8");
  return dir;
}

function run(args: string[], dir: string) {
  return spawnSync(process.execPath, ["run", "src/cli/main.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, MMA_CONFIG_DIR: dir, MMA_LOCALE: "ru", NO_COLOR: "1" },
    timeout: 120_000,
    input: "",
  });
}

describe("интерактивные команды без TTY", () => {
  for (const args of [["meet"], ["agents", "init"]]) {
    it(`${args.join(" ")} → код 1 и причина в stderr`, () => {
      const dir = configDir();
      try {
        const res = run(args, dir);

        expect(res.status).toBe(1);
        expect(String(res.stderr)).toMatch(/интерактивн|interactive/i);
        // stdout остаётся человеческим баннером без текста отказа.
        expect(String(res.stdout)).not.toMatch(/требует интерактивного терминала/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
