// Проверка обновлений по манифесту GitHub Releases и установка релиза.
import { globalMmaDir } from "../../config/paths";
import { installRelease } from "./install-release";
import {
  manifestUrl,
  releaseBase,
  releasePlatformKey,
  type FetchLike,
  type ReleaseManifest,
  type ReleasePlatformKey,
} from "./release";

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

/** Инжектируемые зависимости апдейтера (тесты, кастомные окружения). */
export interface UpdaterDeps {
  /** HTTP-клиент (по умолчанию — глобальный fetch, лениво). */
  fetchImpl?: FetchLike;
  /** Окружение для `MMA_INSTALL_BASE`. */
  env?: NodeJS.ProcessEnv;
  /** Корень установки (по умолчанию `~/.mma`). */
  installRoot?: string;
  /** ОС/архитектура (по умолчанию `process.platform`/`process.arch`). */
  platform?: string;
  arch?: string;
  /** Распаковка tarball'а (инжект для тестов). */
  extract?: (tarball: string, dest: string) => Promise<void>;
}

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

/** Апдейтер пакета: опрос манифеста релиза и установка из GitHub Releases. */
export class Updater {
  private currentVersion: string;
  private env: NodeJS.ProcessEnv;
  private fetchImpl: FetchLike;
  private installRoot: string;
  private platform: string;
  private arch: string;
  private extract?: (tarball: string, dest: string) => Promise<void>;

  constructor(currentVersion: string, deps: UpdaterDeps = {}) {
    this.currentVersion = currentVersion;
    this.env = deps.env ?? process.env;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.installRoot = deps.installRoot ?? globalMmaDir(this.env);
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
    this.extract = deps.extract;
  }

  /** Текущая версия пакета. */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /** Платформенный ключ релиза, либо null. */
  getPlatformKey(): ReleasePlatformKey | null {
    return releasePlatformKey(this.platform, this.arch);
  }

  /** Спрашивает манифест последнего релиза; офлайн/ошибка — флаг false с причиной. */
  async check(): Promise<UpdateCheckResult> {
    try {
      const res = await this.fetchImpl(manifestUrl(this.env), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { updateAvailable: false, current: this.currentVersion, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as ReleaseManifest;
      const latest = data?.version;
      if (!latest) {
        return { updateAvailable: false, current: this.currentVersion, error: "No version in manifest" };
      }
      const updateAvailable = semverGt(latest, this.currentVersion);
      return { updateAvailable, current: this.currentVersion, latest };
    } catch (e) {
      return {
        updateAvailable: false,
        current: this.currentVersion,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Скачивает и активирует свежую версию из GitHub Releases.
   * Возвращает InstallResult (не бросает).
   */
  async install(): Promise<InstallResult> {
    try {
      const key = this.getPlatformKey();
      if (!key) {
        return { success: false, error: `unsupported platform ${this.platform}/${this.arch}` };
      }
      const res = await this.fetchImpl(manifestUrl(this.env), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { success: false, error: `manifest HTTP ${res.status}` };
      const manifest = (await res.json()) as ReleaseManifest;

      const installed = await installRelease({
        manifest,
        key,
        base: releaseBase(this.env),
        fetchImpl: this.fetchImpl,
        installRoot: this.installRoot,
        extract: this.extract,
      });
      return { success: true, installed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg.split("\n")[0] };
    }
  }
}
