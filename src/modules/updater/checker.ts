// Проверка обновлений в npm-реестре и установка свежей версии глобально.
import { platform } from "os";
import { resolveSpawnCommand } from "../lsp/command";

/** Итог проверки: есть ли апдейт, текущая/свежая версии, ошибка. */
export interface UpdateCheckResult {
  updateAvailable: boolean;
  current: string;
  latest?: string;
  error?: string;
}

/** Итог установки: успех, поставленная версия, ошибка. */
export interface InstallResult {
  success: boolean;
  installed?: string;
  error?: string;
}

/** Запуск установки (инжект для тестов; дефолт — execFile). */
export type InstallRunner = (
  command: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ error?: string }>;

/** Численное сравнение semver (x.y.z, пререлизы игнорируются). */
export function semverGt(a: string, b: string): boolean {
  const pa = a
    .replace(/^v/, "")
    .split(/[.-]/)
    .map((p) => Number.parseInt(p, 10) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(/[.-]/)
    .map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

const defaultRunner: InstallRunner = async (command, args, options) => {
  const { execFile } = await import("child_process");
  return new Promise((resolve) => {
    execFile(command, args, options, (err) => resolve({ error: err?.message }));
  });
};

/** Апдейтер пакета: опрос npm-реестра и глобальная установка. */
export class Updater {
  private currentVersion: string;
  private packageName: string;
  private runner: InstallRunner;

  constructor(currentVersion: string, packageName: string, runner?: InstallRunner) {
    this.currentVersion = currentVersion;
    this.packageName = packageName;
    this.runner = runner ?? defaultRunner;
  }

  /** Текущая версия пакета. */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /** Имя пакета в реестре. */
  getPackageName(): string {
    return this.packageName;
  }

  /** Спрашивает реестр о latest-теге; офлайн/ошибка — флаг false с причиной. */
  async check(): Promise<UpdateCheckResult> {
    try {
      const response = await fetch(`https://registry.npmjs.org/${this.packageName}`, {
        headers: { Accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          updateAvailable: false,
          current: this.currentVersion,
          error: `HTTP ${response.status}`,
        };
      }

      const data: any = await response.json();
      const latest = data["dist-tags"]?.latest;

      if (!latest) {
        return { updateAvailable: false, current: this.currentVersion, error: "No latest tag" };
      }

      const updateAvailable = semverGt(latest, this.currentVersion);
      return { updateAvailable, current: this.currentVersion, latest };
    } catch (e: any) {
      return { updateAvailable: false, current: this.currentVersion, error: e.message };
    }
  }

  /**
   * Ставит свежую версию глобально через `npm install -g`.
   * Возвращает InstallResult (не бросает).
   */
  async install(latest: string): Promise<InstallResult> {
    try {
      const { command, args } = this.buildInstallCommand(latest);
      const res = await this.runner(command, args, {
        timeout: 120000,
        windowsHide: true,
      });
      if (res.error) return { success: false, error: res.error };
      return { success: true, installed: latest };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      return { success: false, error: msg.split("\n")[0] };
    }
  }

  private buildInstallCommand(latest: string): { command: string; args: string[] } {
    const npmArgs = ["install", "-g", `${this.packageName}@${latest}`];
    const command = resolveSpawnCommand("npm");
    if (platform() === "win32" && /\.(cmd|bat)$/i.test(command)) {
      // Node не спавнит .cmd/.bat-шимы напрямую (spawn EINVAL) — идём через cmd.exe.
      return { command: "cmd.exe", args: ["/c", command, ...npmArgs] };
    }
    return { command, args: npmArgs };
  }
}
