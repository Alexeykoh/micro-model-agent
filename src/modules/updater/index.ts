// Публичная поверхность самообновления: проверка, установка, модуль, dev-детект.
export { Updater } from "./checker";
export type { UpdateCheckResult, InstallResult, UpdaterDeps } from "./checker";
export { UpdaterModule } from "./module";
export type { UpdaterLogger } from "./module";
export { isDevEntryPath } from "./dev-detect";
export { createUpdater, busLogger, UPDATE_PACKAGE } from "./factory";
export type { CreateUpdaterOptions } from "./factory";
export type { UpdatePhase, UpdateNotice } from "./module";
export {
  MMA_REPO,
  MMA_DEFAULT_RELEASE_BASE,
  releaseBase,
  manifestUrl,
  releasePlatformKey,
  artifactName,
} from "./release";
export type { ReleaseManifest, ReleaseArtifact, ReleasePlatformKey } from "./release";
