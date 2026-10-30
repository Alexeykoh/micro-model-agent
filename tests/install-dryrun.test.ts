// Installer dry-run: asserts each bootstrap script resolves the release base and
// the platform artifact without touching the network or the filesystem. The
// matching shell is only present on its own OS, so each case is skipped there.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
// pwsh (PowerShell 7) — отдельный бинарь: Windows без него ставит только
// powershell.exe. Проверяем наличие, а не платформу, иначе набор падает
// «Executable not found in $PATH: pwsh» вместо осмысленного прогона.
const hasPwsh = (() => {
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
  return !r.error && r.status === 0;
})();
const DRY_ENV = { ...process.env, MMA_INSTALL_DRY_RUN: "1" };

describe("installer dry-run", () => {
  it.skipIf(isWin)("install.sh prints the macOS/Linux plan", () => {
    const res = spawnSync("bash", ["scripts/install.sh"], { env: DRY_ENV, encoding: "utf8" });
    if (res.error) return; // bash unavailable — nothing to assert
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("latest.json");
    expect(res.stdout).toContain("mma-");
  });

  it.skipIf(!isWin || !hasPwsh)("install.ps1 prints the Windows plan", () => {
    const res = spawnSync("pwsh", ["-NoProfile", "-File", "scripts/install.ps1"], {
      env: DRY_ENV,
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("latest.json");
    expect(res.stdout).toContain("mma-win-");
  });
});
