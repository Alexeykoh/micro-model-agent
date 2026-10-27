// Валидация путей: джейл baseDir, симлинки, deny/allow-паттерны, скоуп суб-агента.
import { resolve, normalize, dirname } from "path";
import { realpathSync } from "fs";
import { isInsideDir, matchesScopeEntry } from "../../tools/path-utils";
import { matchesGlobPattern } from "./path-glob";
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

/**
 * Workdir тула `bash` (аудит §4.1): рабочий каталог обязан лежать внутри
 * `baseDir`. Без этой проверки модель одной командой уходила за пределы
 * проекта (`workdir: C:\Users\…`).
 *
 * Скоуп субагента здесь НЕ ограничивает cwd (спека
 * `2026-10-27-subagent-reliability-design` §A): `allowed_files` — список файлов,
 * а `bash` работает каталогом, и команда с cwd `src/` всё равно читает
 * `../package.json`. Граница shell — `baseDir`; настоящий ограничитель — набор
 * тулов (`bash` живёт под тегом `shell`, которого у ребёнка может не быть).
 * Скоуп остаётся правом записи: без `allowed_files` shell субагенту не даётся.
 *
 * Проверка лексическая + symlink-контеймент: `bash` не умеет работать с
 * несуществующим каталогом, поэтому «путь не создан» — не повод пропустить.
 */
export function validateWorkdir(
  baseDir: string,
  workdir: string,
  scope?: ToolScope,
): PathValidationResult {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(workdir));

  if (!isInsideDir(targetResolved, baseResolved)) {
    return {
      allowed: false,
      reason: "Workdir is outside the base working directory",
    };
  }
  if (escapesViaSymlink(baseResolved, targetResolved)) {
    return {
      allowed: false,
      reason: "Workdir resolves outside the base working directory via symlink",
    };
  }

  if (!scope) return { allowed: true };

  // Скоуп субагента: `bash` — тул с записью, поэтому право на него даёт
  // непустой `allowed_files`. Read-only-скоуп (`read_only_files`) тулу с
  // записью не подходит: работать там можно только на чтение, а `bash` этого
  // не умеет. Куда указывает cwd, не проверяем — см. комментарий функции.
  if (scope.allowed_files.length === 0) {
    return {
      allowed: false,
      reason: "Sub-agent has no writable scope for bash",
    };
  }
  return { allowed: true };
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
