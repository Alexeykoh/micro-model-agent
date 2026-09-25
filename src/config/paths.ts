/**
 * Canonical filesystem locations for MMA.
 *
 * Centralizes the `.mma` directory name and the global/project path shapes so a
 * change (e.g. a rename or an env override) has one source of truth instead of
 * ~50 literal `join(…, ".mma", …)` sites.
 *
 * Layering: this module imports only `node:os`/`node:path`, so any layer may
 * import it without cycles.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory name of the agent's data dir (global `~/.mma`, project `<ws>/.mma`). */
export const MMA_DIR_NAME = ".mma";

/** Legacy single-file global config path (`~/.mma/config.json`). */
export const MMA_CONFIG_FILE_NAME = "config.json";

/**
 * Global agent data dir. Honors `MMA_CONFIG_DIR` (the same override `loadConfig`
 * and bootstrap use), falling back to `~/.mma`.
 */
export function globalMmaDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MMA_CONFIG_DIR || join(homedir(), MMA_DIR_NAME);
}

/** Project-local agent data dir (`<baseDir>/.mma`). */
export function projectMmaDir(baseDir: string): string {
  return join(baseDir, MMA_DIR_NAME);
}

/** Legacy global config file (`<global>/.mma/config.json`). */
export function globalConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), MMA_CONFIG_FILE_NAME);
}

/** Global memory dir (`<global>/.mma/memory`). */
export function globalMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "memory");
}

/** Global sessions dir (`<global>/.mma/sessions`). */
export function globalSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "sessions");
}

/** Global logs dir (`<global>/.mma/logs`). */
export function globalLogsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "logs");
}

/** Default export dir (`<global>/.mma/exports`). */
export function globalExportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "exports");
}

/** Global plugins dir (`<global>/.mma/plugins`). */
export function globalPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalMmaDir(env), "plugins");
}
