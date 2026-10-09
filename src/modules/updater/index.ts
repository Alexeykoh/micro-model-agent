// Публичная поверхность самообновления: проверка, установка, модуль, dev-детект.
export { Updater } from "./checker";
export type { UpdateCheckResult, InstallResult } from "./checker";
export { UpdaterModule } from "./module";
export type { UpdaterLogger } from "./module";
export { isDevEntryPath } from "./dev-detect";
export { createUpdater, busLogger, UPDATE_PACKAGE } from "./factory";
export type { CreateUpdaterOptions } from "./factory";
export type { UpdatePhase, UpdateNotice } from "./module";
