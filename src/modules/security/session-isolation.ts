// Изоляция сессий: свой temp-каталог, свои security-оверрайды, скоуп путей.
import { join, resolve } from "path";
import { mkdirSync, existsSync } from "fs";
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
  /** Базовый каталог данных сессии. Дефолт: ~/.mma/sessions/<session-id> */
  baseDir?: string;
  /** Изолировать плагины на сессию */
  isolatePlugins: boolean;
  /** Изолировать временные файлы на сессию */
  isolateTempFiles: boolean;
}

/** Дефолтный конфиг изоляции сессий (выключена). */
export const DEFAULT_SESSION_ISOLATION: SessionIsolationConfig = {
  enabled: false,
  isolatePlugins: true,
  isolateTempFiles: true,
};

/** Контекст сессии: id, temp-каталог, security-оверрайды, рабочий каталог. */
export interface SessionContext {
  /** Уникальный id сессии */
  sessionId: string;
  /** Временный каталог сессии */
  tempDir: string;
  /** Security-оверрайды сессии */
  securityOverrides?: Partial<SecurityConfig>;
  /** Рабочий каталог сессии */
  workingDir: string;
}

/** Создать контекст сессии с изоляцией (temp-каталог 0700). */
export function createSessionContext(
  sessionId: string,
  projectDir: string,
  isolationConfig?: SessionIsolationConfig,
  securityOverrides?: Partial<SecurityConfig>,
): SessionContext {
  const config = { ...DEFAULT_SESSION_ISOLATION, ...isolationConfig };

  // Временный каталог сессии
  const baseDir = config.baseDir || join(globalSessionsDir(), sessionId);
  const tempDir = join(baseDir, "temp");

  if (config.isolateTempFiles && !existsSync(tempDir)) {
    try {
      mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    } catch {
      // Каталог не создался — работаем без изоляции
    }
  }

  return {
    sessionId,
    tempDir,
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

/** Временный каталог сессии. */
export function getSessionTempDir(sessionContext: SessionContext): string {
  return sessionContext.tempDir;
}

/** Убрать временные данные сессии (пока no-op — чистит ОС). */
export function cleanupSessionTempDir(_sessionContext: SessionContext): void {
  // Заглушка: рекурсивное удаление не реализовано, чистит ОС.
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
