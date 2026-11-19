/** Рантайм-контекст политики: реальные значения машины/путей для value-based детекции. */
import { homedir, hostname, userInfo } from "node:os";

export interface PolicyContext {
  /** Рабочий каталог (workspace); его префикс заменяется при `pathMode:prefix`. */
  baseDir: string;
  /** Домашний каталог (os.homedir()). */
  home?: string;
  /** Имя компьютера (os.hostname()). */
  hostname?: string;
  /** Имя пользователя. */
  username?: string;
  /** Платформа ОС (`process.platform`), напр. `win32`. */
  platform?: string;
  /** Архитектура (`process.arch`), напр. `x64`. */
  arch?: string;
  /** Окружение (process.env) — имена/значения чувствительных переменных. */
  env?: Record<string, string | undefined>;
  /** Дополнительные корни, чьи префиксы считаются машинными путями. */
  workspaceRoots?: string[];
}

/**
 * Машинный контекст из реального окружения процесса. Один источник и для
 * bootstrap-фабрики guard'а (E1), и для проекции произвольного внешнего
 * egress (web_search): дублировать `os.homedir()`/`hostname()` по местам нельзя —
 * расхождение даст «в одном месте путь маскируется, в другом нет».
 */
export function machinePolicyContext(projectDir?: string, configDir?: string): PolicyContext {
  let username: string | undefined;
  try {
    username = userInfo().username;
  } catch {
    username = process.env.USERNAME ?? process.env.USER;
  }
  return {
    baseDir: projectDir ?? process.cwd(),
    home: homedir(),
    hostname: hostname(),
    username,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    workspaceRoots: configDir ? [configDir] : [],
  };
}
