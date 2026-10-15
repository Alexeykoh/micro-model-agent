// Валидация путей: джейл baseDir, симлинки, deny/allow-паттерны, скоуп суб-агента.
import { resolve, normalize, dirname } from "path";
import { realpathSync } from "fs";
import { isInsideDir, matchesScopeEntry, toForwardSlash } from "../../tools/path-utils";
import type { PathSecurityConfig } from "../../config/types";
import type { ToolScope } from "../../tools/types";

/** Итог проверки пути: разрешено/запрет с причиной. */
export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Симлинк-контейнмент: resolve() симлинки НЕ резолвит, и симлинк
 * (или Windows-junction) внутри baseDir может указывать наружу.
 * Существующая цель обязана остаться внутри реального base. Для ещё не
 * созданного листа каноникализируется ближайший СУЩЕСТВУЮЩИЙ предок —
 * иначе `base/link/new.txt` проскочил бы, когда `link` смотрит наружу.
 * False (судить нельзя), если нет самого baseDir: чисто лексическая
 * проверка продолжает работать на виртуальных путях.
 */
function escapesViaSymlink(baseResolved: string, targetResolved: string): boolean {
  let realBase: string;
  try {
    realBase = realpathSync(baseResolved);
  } catch {
    // baseDir нет (виртуальный путь / фикстура) — каноникализировать нечего.
    return false;
  }

  let probe = targetResolved;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return real !== realBase && !isInsideDir(real, realBase);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false; // корень, ничего не существует
      probe = parent;
    }
  }
}

/**
 * Путь в разрешённом скоупе или нет.
 * Комбинирует глобальные настройки и per-tool скоуп.
 */
export function isPathInScope(
  baseDir: string,
  targetPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): PathValidationResult {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(targetPath));

  // Сначала — внутри baseDir (сепараторо- и регистро-безопасно: соседний
  // каталог с общим префиксом пройти не должен).
  if (!isInsideDir(targetResolved, baseResolved)) {
    return {
      allowed: false,
      reason: "Path is outside the base working directory",
    };
  }
  if (escapesViaSymlink(baseResolved, targetResolved)) {
    return {
      allowed: false,
      reason: "Path resolves outside the base working directory via symlink",
    };
  }

  // Fail-closed (D8): нет секции — не «разрешено всё»; enabled:false и скоуп — как были.
  if (!securityConfig?.enabled) {
    // Скоуп суб-агента действует всё равно
    if (scope) {
      const isReadScope = scope.read_only_files.some((f: string) => matchesScopeEntry(targetResolved, resolve(baseDir, f)));
      const isWriteScope = scope.allowed_files.some((f: string) =>
        matchesScopeEntry(targetResolved, resolve(baseDir, f)),
      );
      if (isWriteScope) return { allowed: true };
      if (isReadScope) return { allowed: true, reason: "Read-only file" };
      return {
        allowed: false,
        reason: "Path is not within the allowed scope for this sub-agent",
      };
    }
    if (!securityConfig) return { allowed: false, reason: "No path security configuration (fail-closed)" };
    return { allowed: true };
  }

  // Глобальные denied-паттерны
  if (securityConfig?.denied?.length) {
    for (const pattern of securityConfig.denied) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        return {
          allowed: false,
          reason: `Path matches denied pattern: ${pattern}`,
        };
      }
    }
  }

  // Глобальные allowed-паттерны (непустые — разрешены только совпавшие)
  if (securityConfig?.allowed?.length) {
    let isAllowed = false;
    for (const pattern of securityConfig.allowed) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      return {
        allowed: false,
        reason: "Path does not match any allowed pattern",
      };
    }
  }

  // Per-tool скоуп (для суб-агентов)
  if (!scope) {
    return { allowed: true };
  }

  const isRead = scope.read_only_files.some((f: string) =>
    matchesScopeEntry(targetResolved, resolve(baseDir, f)),
  );
  const isWrite = scope.allowed_files.some((f: string) =>
    matchesScopeEntry(targetResolved, resolve(baseDir, f)),
  );

  if (isWrite) return { allowed: true };
  if (isRead) return { allowed: true, reason: "Read-only file" };

  return {
    allowed: false,
    reason: "Path is not within the allowed scope for this sub-agent",
  };
}

/** Путь доступен для записи (операции write/delete) или нет. */
export function isPathWritable(
  baseDir: string,
  targetPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): PathValidationResult {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(targetPath));

  // Сначала — внутри baseDir (сепараторо- и регистро-безопасно: соседний
  // каталог с общим префиксом пройти не должен).
  if (!isInsideDir(targetResolved, baseResolved)) {
    return {
      allowed: false,
      reason: "Path is outside the base working directory",
    };
  }
  // Запись не следует за симлинком/junction наружу из baseDir (путь чтения
  // проверял это всегда; путь записи раньше пропускал).
  if (escapesViaSymlink(baseResolved, targetResolved)) {
    return {
      allowed: false,
      reason: "Path resolves outside the base working directory via symlink",
    };
  }

  // Fail-closed (D8): нет конфиг-секции = отказ, а не «пропускаем паттерны».
  if (!securityConfig?.enabled) {
    // Скоуп суб-агента действует всё равно
    if (scope) {
      const isWriteScope = scope.allowed_files.some((f: string) =>
        matchesScopeEntry(targetResolved, resolve(baseDir, f)),
      );
      if (isWriteScope) return { allowed: true };
      return {
        allowed: false,
        reason: "Path is not within the allowed scope for this sub-agent",
      };
    }
    if (!securityConfig) return { allowed: false, reason: "No path security configuration (fail-closed)" };
    return { allowed: true };
  }

  // Глобальные denied-паттерны
  if (securityConfig?.denied?.length) {
    for (const pattern of securityConfig.denied) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        return {
          allowed: false,
          reason: `Path matches denied pattern: ${pattern}`,
        };
      }
    }
  }

  // Глобальные allowed-паттерны (непустые — разрешены только совпавшие)
  if (securityConfig?.allowed?.length) {
    let isAllowed = false;
    for (const pattern of securityConfig.allowed) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      return {
        allowed: false,
        reason: "Path does not match any allowed pattern",
      };
    }
  }

  // Per-tool скоуп (для суб-агентов)
  if (!scope) {
    return { allowed: true };
  }

  const isWrite = scope.allowed_files.some((f: string) =>
    matchesScopeEntry(targetResolved, resolve(baseDir, f)),
  );

  if (isWrite) return { allowed: true };

  return {
    allowed: false,
    reason: "Path is not within the writable scope for this sub-agent",
  };
}

/**
 * Простой glob-матчинг (поддерживает * и **).
 * Упрощённая версия для типовых случаев.
 */
function matchesGlobPattern(targetPath: string, baseDir: string, pattern: string): boolean {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedTargetPath = resolve(targetPath);

  // Относительный путь для посегментного матчинга
  const relPath = resolvedTargetPath.startsWith(resolvedBaseDir)
    ? resolvedTargetPath.slice(resolvedBaseDir.length).replace(/^\//, "")
    : resolvedTargetPath;

  // Паттерны с ** (рекурсивный матчинг каталогов)
  if (pattern.includes("**")) {
    // Разбить по ** на префикс/суффикс
    const cleaned = pattern.replace(/\/$/, "");
    const [rawPrefix, rawSuffix] = cleaned.split("**");
    const prefix = rawPrefix.replace(/\/$/, "");
    const suffix = rawSuffix.replace(/^\//, "");

    // Префикс: всё до ** обязано совпасть с началом пути
    if (prefix) {
      const prefixParts = prefix.split("/").filter(Boolean);
      const relParts = relPath.split("/");
      for (let i = 0; i < prefixParts.length; i++) {
        if (relParts[i] !== prefixParts[i]) return false;
      }
    }

    // ** в конце матчит всё
    if (!suffix) return true;

    // Суффикс против оставшихся сегментов
    const suffixParts = suffix.split("/").filter(Boolean);
    const relParts = relPath.split("/");
    // Ищем совпадение суффикса в любой позиции оставшегося пути
    for (let start = (prefix ? prefix.split("/").filter(Boolean).length : 0); start <= relParts.length - suffixParts.length; start++) {
      let match = true;
      for (let j = 0; j < suffixParts.length; j++) {
        if (suffixParts[j] === "*") continue;
        if (relParts[start + j] !== suffixParts[j]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  // Паттерны каталогов (с / на конце) без **
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.slice(0, -1);
    const resolvedDirPattern = resolve(baseDir, dirPattern);
    return isInsideDir(resolvedTargetPath, resolvedDirPattern);
  }

  // Паттерн * (один уровень) без **
  if (pattern.includes("*")) {
    const regexPattern = pattern
      .replace(/\*/g, "[^/\\\\]*")
      .replace(/\?/g, ".")
      .replace(/\./g, "\\.");

    const regex = new RegExp(`^${regexPattern}$`);
    const relativePath = toForwardSlash(resolvedTargetPath.slice(resolvedBaseDir.length + 1));
    return regex.test(relativePath);
  }

  // Точное совпадение (на win32 регистронезависимо — там FS такая)
  const exactTarget = resolve(baseDir, pattern);
  if (process.platform === "win32") {
    return resolvedTargetPath.toLowerCase() === exactTarget.toLowerCase();
  }
  return resolvedTargetPath === exactTarget;
}
