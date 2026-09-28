/**
 * Канонические пути MMA на диске.
 *
 * Централизует имя каталога `.mma` и формы глобальных/проектных путей: смена
 * (переименование, env-оверрайд) правится в одном месте, а не в ~50 литералах
 * `join(…, ".mma", …)`.
 *
 * Слоистость: модуль импортит только `node:os`/`node:path`, его может импортить
 * любой слой без циклов.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { MMA_ENV } from "./env";

/** Имя каталога данных агента (глобальный `~/.mma`, проектный `<ws>/.mma`). */
export const MMA_DIR_NAME = ".mma";

/** Имя legacy-файла глобального конфига (`~/.mma/config.json`). */
export const MMA_CONFIG_FILE_NAME = "config.json";

/**
 * Глобальный каталог данных. Уважает `MMA_CONFIG_DIR` (тот же оверрайд, что у
 * `loadConfig` и bootstrap), иначе `~/.mma`.
 */
export function globalMmaDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[MMA_ENV.CONFIG_DIR] || join(homedir(), MMA_DIR_NAME);
}

/** Проектный каталог данных (`<baseDir>/.mma`). */
export function projectMmaDir(baseDir: string): string {
  return join(baseDir, MMA_DIR_NAME);
}

/** Legacy-файл глобального конфига (`<global>/.mma/config.json`). */
export function globalConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), MMA_CONFIG_FILE_NAME);
}

/** Глобальный каталог памяти (`<global>/.mma/memory`). */
export function globalMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "memory");
}

/** Глобальный каталог сессий (`<global>/.mma/sessions`). */
export function globalSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "sessions");
}

/** Глобальный каталог логов (`<global>/.mma/logs`). */
export function globalLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "logs");
}

/** Каталог экспорта по умолчанию (`<global>/.mma/exports`). */
export function globalExportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "exports");
}

/** Глобальный каталог плагинов (`<global>/.mma/plugins`). */
export function globalPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "plugins");
}

/** Файл аудит-лога в каталоге данных (`<dir>/audit.jsonl`). */
export function auditLogFile(dir: string): string {
  return join(dir, "audit.jsonl");
}
