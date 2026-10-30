// Кэш тестового прогона финального аудита по отпечатку дерева (в памяти процесса).
//
// Спека: docs/specs/2026-10-30-audit-test-run-budget-design.md. Повторный аудит на
// неизменном дереве (частый случай: audit-gate переспросил, модель ответила без
// правок) не должен второй раз платить полный прогон.
import { existsSync, readdirSync, statSync } from "fs";
import type { Dirent } from "fs";
import { join, resolve } from "path";
import { SKIP_DIRS, resolveTestCommand } from "./audit-runners";
import type { TestRunCheck } from "./audit-runners";

interface CachedTestRun {
  /** Отпечаток дерева, при котором снят результат (`testTreeFingerprint`). */
  fingerprint: string;
  result: TestRunCheck;
}

/** Один слот на проект: держим последний прогон, история не нужна. */
const cache = new Map<string, CachedTestRun>();

/** Кап числа файлов в отпечатке: больше — отпечаток не считаем (кэш off). */
const FINGERPRINT_MAX_FILES = 20_000;

/**
 * Отпечаток состояния дерева: относительный путь + mtime + size каждого файла
 * (кроме SKIP_DIRS) плюс stamp `package.json` и резолвленная тестовая команда.
 *
 * В отпечаток входит **всё дерево**, а не только тестовые файлы: изменение
 * исходника под тестом обязано инвалидировать кэш, иначе аудит отдал бы
 * прошлое «passed» на сломанном коде. `null` — отпечаток недостоверен
 * (слишком много файлов/ошибка ФС), кэш в этом случае не используется.
 */
export function testTreeFingerprint(dir: string): string | null {
  const stamps: string[] = [];
  const walk = (current: string, rel: string, depth: number): boolean => {
    if (depth > 5) return true;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (!walk(full, relPath, depth + 1)) return false;
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = statSync(full);
        stamps.push(`${relPath}:${st.mtimeMs}:${st.size}`);
      } catch {
        return false;
      }
      if (stamps.length > FINGERPRINT_MAX_FILES) return false;
    }
    return true;
  };
  if (!walk(dir, "", 0)) return null;
  stamps.sort();
  let pkgStamp = "no-package.json";
  try {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const st = statSync(pkg);
      pkgStamp = `package.json:${st.mtimeMs}:${st.size}`;
    }
  } catch {
    return null;
  }
  return `${pkgStamp}|${resolveTestCommand(dir)}|${stamps.join(";")}`;
}

/** Кэш по проекту: ключ — абсолютный `baseDir` (регистр в пути не нормализуем). */
function keyOf(baseDir: string): string {
  return resolve(baseDir);
}

/**
 * Отдаёт закэшированный прогон для того же отпечатка дерева.
 *
 * @param baseDir корень проекта; @param fingerprint текущий отпечаток дерева.
 * @returns копия результата с `cached: true` или null (промах/дерево изменилось).
 */
export function getCachedTestRun(baseDir: string, fingerprint: string): TestRunCheck | null {
  const hit = cache.get(keyOf(baseDir));
  if (!hit || hit.fingerprint !== fingerprint) return null;
  return { ...hit.result, cached: true, durationMs: 0, detail: `${hit.result.detail} · cached` };
}

/**
 * Кладёт реальный прогон в кэш. `inconclusive`/`skipped` — не результат:
 * таймаут не должен «залипнуть» как успех, а скип не должен подменять прогон
 * на следующем ходе, где мутации уже есть.
 */
export function setCachedTestRun(baseDir: string, fingerprint: string, result: TestRunCheck): void {
  if (result.status !== "passed" && result.status !== "failed") return;
  cache.set(keyOf(baseDir), {
    fingerprint,
    result: { ...result, cached: false, detail: result.detail.replace(/ · cached$/, "") },
  });
}

/** Сбрасывает кэш (тесты, диагностика): следующая проверка прогонит раннер. */
export function clearTestRunCache(): void {
  cache.clear();
}
