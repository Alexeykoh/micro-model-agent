/** Рантайм-контекст политики: реальные значения машины/путей для value-based детекции. */
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
