// Резолв PowerShell 7 для тестов установщика.
//
// Windows-машина может иметь pwsh только как MSIX-пакет (winget/Store): его
// app-execution alias в `WindowsApps` не запускается из Node/Bun по имени
// (`spawnSync("pwsh")` → ENOENT), хотя `where pwsh` его находит. Перечислить
// `WindowsApps` нельзя (EPERM), поэтому путь пакета спрашиваем у Windows
// PowerShell. `null` — pwsh действительно нет, и набор честно скипается с
// объявленной причиной.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function works(cmd: string): boolean {
  const r = spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/** Каталог MSIX-пакета PowerShell (пусто, если пакета нет). */
function appxLocation(): string | null {
  if (process.platform !== "win32") return null;
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AppxPackage Microsoft.PowerShell).InstallLocation",
    ],
    { encoding: "utf8" },
  );
  if (r.error || r.status !== 0) return null;
  const lines = String(r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

export function resolvePwsh(): string | null {
  if (works("pwsh")) return "pwsh";
  if (process.platform !== "win32") return null;
  const candidates: string[] = [];
  const msi = join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  candidates.push(msi);
  const appx = appxLocation();
  if (appx) candidates.push(join(appx, "pwsh.exe"));
  for (const exe of candidates) {
    if (works(exe)) return exe;
  }
  return null;
}
