// Изоляция сессий: свой temp-каталог, свои security-оверрайды, скоуп путей.
import { join, resolve } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";
import type { SecurityConfig, AppConfig } from "../../config/types";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";
import { isInsideDir } from "../../tools/path-utils";
import { globalSessionsDir } from "../../config/paths";

/** Конфиг изоляции сессий. */
export interface SessionIsolationConfig {
  /**
   * Включить изоляцию. У каждой сессии свои:
   * - временный каталог
   * - инстансы плагинов
   * - security-оверрайды
   */
  enabled: boolean;
  /** Базовый каталог для изолированных сессий. По умолчанию: ~/.mma/sessions/<session-id> */
  baseDir?: string;
  /** Изолировать временные файлы на сессию */
  isolateTempFiles: boolean;
}

/** Дефолтный конфиг изоляции сессий (выключена). */
export const DEFAULT_SESSION_ISOLATION: SessionIsolationConfig = {
  enabled: false,
  isolateTempFiles: true,
};

/** Контекст сессии: id, temp-каталог, security-оверрайды, рабочий каталог. */
export interface SessionContext {
  /** Уникальный id сессии */
  sessionId: string;
  /** Временный каталог сессии (создаётся лениво — `getSessionTempDir`, INV-W4) */
  tempDir: string;
  /**
   * Изолировать временные файлы. `false` — `getSessionTempDir` не создаёт
   * каталог, а возвращает путь как есть.
   */
  isolateTempFiles: boolean;
  /** Security-оверрайды сессии */
  securityOverrides?: Partial<SecurityConfig>;
  /** Рабочий каталог сессии */
  workingDir: string;
}

/**
 * Контекст сессии с изоляцией.
 *
 * На диск НЕ пишется (INV-W4): раньше здесь создавался `temp`, и в
 * `~/.mma/sessions` накопились тысячи каталогов, содержащих только пустой
 * `temp` — они же раздували `countSessions()` и гасили автоочистку.
 * Каталог создаётся при первом обращении (`getSessionTempDir`).
 */
export function createSessionContext(
  sessionId: string,
  projectDir: string,
  isolationConfig?: SessionIsolationConfig,
  securityOverrides?: Partial<SecurityConfig>,
): SessionContext {
  const config = { ...DEFAULT_SESSION_ISOLATION, ...isolationConfig };
  const baseDir = config.baseDir || join(globalSessionsDir(), sessionId);

  return {
    sessionId,
    tempDir: join(baseDir, "temp"),
    isolateTempFiles: config.isolateTempFiles,
    securityOverrides,
    workingDir: projectDir,
  };
}

/**
 * Security-конфиг сессии: глобальный + оверрайды (вложенные объекты мержатся).
 */
export function getSessionSecurityConfig(
  globalConfig: AppConfig,
  sessionContext?: SessionContext,
): SecurityConfig {
  const globalSecurity = globalConfig.security || DEFAULT_SECURITY_CONFIG;
  const sessionOverrides = sessionContext?.securityOverrides;

  if (!sessionOverrides) {
    return globalSecurity;
  }

  return {
    ...globalSecurity,
    ...sessionOverrides,
    // Вложенные объекты — мерж, не замена
    bash: { ...globalSecurity.bash, ...sessionOverrides.bash },
    paths: { ...globalSecurity.paths, ...sessionOverrides.paths },
    network: { ...globalSecurity.network, ...sessionOverrides.network },
    rateLimits: { ...globalSecurity.rateLimits, ...sessionOverrides.rateLimits },
    contentScan: { ...globalSecurity.contentScan, ...sessionOverrides.contentScan },
  };
}

/**
 * Временный каталог сессии, создавая его при первом обращении (INV-W4).
 * Пустой каталог ради «на всякий случай» не создаём: он и есть источник
 * сирот в `~/.mma/sessions`.
 */
export function getSessionTempDir(sessionContext: SessionContext): string {
  if (!sessionContext.isolateTempFiles || existsSync(sessionContext.tempDir)) {
    return sessionContext.tempDir;
  }
  try {
    mkdirSync(sessionContext.tempDir, { recursive: true, mode: 0o700 });
  } catch {
    // Каталог не создался — работаем без изоляции
  }
  return sessionContext.tempDir;
}

/** Убрать временные данные сессии; отсутствующий каталог — не ошибка. */
export function cleanupSessionTempDir(sessionContext: SessionContext): void {
  if (!existsSync(sessionContext.tempDir)) return;
  try {
    rmSync(sessionContext.tempDir, { recursive: true, force: true });
  } catch {
    // Fail-open: чистка не должна ронять завершение сессии; ОС подчистит позже.
  }
}

/**
 * Путь к файлу сессии: обязан лежать в рабочем или temp-каталоге сессии.
 */
export function createSessionFilePath(
  sessionContext: SessionContext,
  relativePath: string,
  useTempDir: boolean = false,
): string {
  const baseDir = useTempDir ? sessionContext.tempDir : sessionContext.workingDir;
  return resolve(baseDir, relativePath);
}

/** Путь в разрешённых каталогах сессии (рабочий или temp) или нет. */
export function isPathInSessionScope(sessionContext: SessionContext, path: string): boolean {
  const resolvedPath = resolve(path);
  const workingDir = resolve(sessionContext.workingDir);
  const tempDir = resolve(sessionContext.tempDir);

  return isInsideDir(resolvedPath, workingDir) || isInsideDir(resolvedPath, tempDir);
}
