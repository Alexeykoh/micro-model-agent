/**
 * Контракт раздачи релиза: базовый URL, ключи платформ и схема манифеста.
 *
 * Один источник правды для bootstrap-скриптов (`scripts/install.*`), сборки
 * релиза (`scripts/stage-release.ts`) и апдейтера (`src/modules/updater`).
 * Артефакты лежат в GitHub Releases; имена версионно-нейтральные, поэтому
 * `releases/latest/download/<asset>` резолвится стабильно.
 */

/** Репозиторий на GitHub. */
export const MMA_REPO = "Alexeykoh/micro-model-agent";

/** База скачивания последнего релиза (переопределяется `MMA_INSTALL_BASE`). */
export const MMA_DEFAULT_RELEASE_BASE = `https://github.com/${MMA_REPO}/releases/latest/download`;

/** Имя манифеста в релизе. */
export const RELEASE_MANIFEST_NAME = "latest.json";

/** Ключ платформы в манифесте. */
export type ReleasePlatformKey =
  | "win-x64"
  | "mac-arm64"
  | "mac-x64"
  | "linux-x64"
  | "linux-arm64";

const VALID_KEYS: readonly ReleasePlatformKey[] = [
  "win-x64",
  "mac-arm64",
  "mac-x64",
  "linux-x64",
  "linux-arm64",
];

/** HTTP-клиент (совместим с глобальным fetch, но без `preconnect` из Bun-типов). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Артефакт одной платформы. */
export interface ReleaseArtifact {
  /** Имя файла в релизе (относительно базы). */
  url: string;
  sha256: string;
  size: number;
}

/** Манифест последнего релиза (`latest.json`). */
export interface ReleaseManifest {
  version: string;
  releasedAt: string;
  artifacts: Partial<Record<ReleasePlatformKey, ReleaseArtifact>>;
}

/** База скачивания: `MMA_INSTALL_BASE` или GitHub Releases по умолчанию. */
export function releaseBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MMA_INSTALL_BASE?.trim();
  return override ? override.replace(/\/+$/, "") : MMA_DEFAULT_RELEASE_BASE;
}

/** URL манифеста последнего релиза. */
export function manifestUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${releaseBase(env)}/${RELEASE_MANIFEST_NAME}`;
}

/** Имя артефакта платформы (версионно-нейтральное). */
export function artifactName(key: ReleasePlatformKey): string {
  return `mma-${key}.tar.gz`;
}

/** URL артефакта платформы, отн. манифеста. */
export function artifactUrl(key: ReleasePlatformKey): string {
  return artifactName(key);
}

/**
 * Ключ платформы по ОС/архитектуре, либо `null` для неподдерживаемой пары.
 * `platform` — Node/Bun `process.platform`, `arch` — `process.arch`.
 */
export function releasePlatformKey(
  platform: string,
  arch: string,
): ReleasePlatformKey | null {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "mac" : platform === "linux" ? "linux" : null;
  if (!os) return null;
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!a) return null;
  const key = `${os}-${a}` as ReleasePlatformKey;
  return VALID_KEYS.includes(key) ? key : null;
}
