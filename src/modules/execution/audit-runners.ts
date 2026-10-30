// Раннеры финального аудита: поиск тестов, прогон тестов, поиск корня typecheck.
import { existsSync, readdirSync, readFileSync } from "fs";
import type { Dirent } from "fs";
import { dirname, join, resolve } from "path";
import { detectTestResults } from "../../tools/bash";
import { processRegistry } from "../processes";
import { resolveTscCommand } from "../lsp/project-root";
import { AUDIT_TEST_RUN_BUDGET_MS, AUDIT_TYPECHECK_BUDGET_MS } from "../../config/timeouts";

/** Каталоги, где тестовые файлы не ищем. */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".mma",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
]);

const TEST_EXT_RE = /\.(test|spec)\.[jt]sx?$/i;
const PY_TEST_RE = /^test_.*\.py$|^.*_test\.py$/i;

/**
 * Резолвит тестовую команду проекта из манифеста: финальный аудит реально
 * гоняет раннер проекта, а не всегда `bun test` (Python/Go-проект или
 * vitest/jest-сетап под bun test упал бы или молча не дал сводки).
 *
 * Приоритет: package.json scripts.test → конфиги тест-фреймворков → Python-
 * маркеры (pyproject/pytest.ini/conftest.py) → go.mod → Cargo.toml → bun.
 */
export function resolveTestCommand(dir: string): string {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const script = pkg?.scripts?.test;
      if (typeof script === "string" && script.trim()) return script.trim();
    } catch {
      /* битый package.json — идём дальше */
    }
  }
  for (const f of [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "jest.config.js",
    "jest.config.ts",
    "jest.config.mjs",
    "jest.config.cjs",
    "bunfig.toml",
  ]) {
    if (existsSync(join(dir, f))) {
      if (f.startsWith("vitest")) return "bunx vitest run";
      if (f.startsWith("jest")) return "npx --no-install jest";
      if (f === "bunfig.toml") return "bun test";
    }
  }
  if (
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "pytest.ini")) ||
    existsSync(join(dir, "conftest.py"))
  ) {
    return "python -m pytest -q";
  }
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test";
  return "bun test";
}

/** Результат тестового прогона: был ли прогон, прошёл ли, счётчики, детали, команда. */
export type TestRunStatus =
  /** Раннер отработал и все найденные тесты прошли. */
  | "passed"
  /** Раннер отработал, есть упавшие тесты. */
  | "failed"
  /** Прогон не доведён (таймаут, нет сводки) — вердикт «не знаем», не «прошло». */
  | "inconclusive"
  /** Прогон не запускался: сломать тесты было нечем (нет мутаций за ход). */
  | "skipped";

/** Итог прогона: статус, счётчики, причина и длительность. */
export interface TestRunCheck {
  /** Реальный тестовый прогон вообще выполнялся. */
  checked: boolean;
  /** Все найденные тесты прошли. `false` у failed/inconclusive/skipped. */
  passed: boolean;
  /** Честный статус: блокирует завершение только `failed`. */
  status: TestRunStatus;
  failed: number;
  passedCount: number;
  /** Короткий список упавших тестов (до 5) или сводка раннера. */
  detail: string;
  command: string;
  /** Сколько занял прогон, мс (0 у skipped/cached). */
  durationMs: number;
  /** Результат взят из кэша неизменного дерева — раннер не запускался. */
  cached?: boolean;
}

/** Рекурсивный поиск тестового файла с капом глубины и ранним выходом. */
export function findTestFile(dir: string, depth = 0): string | null {
  if (depth > 5) return null;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const found = findTestFile(full, depth + 1);
      if (found) return found;
    } else if (TEST_EXT_RE.test(e.name) || PY_TEST_RE.test(e.name)) {
      return full;
    }
  }
  return null;
}

/** Вытаскивает имена упавших тестов из вывода раннера (стиль bun/vitest). */
function extractFailingNames(output: string, limit = 5): string[] {
  const names: string[] = [];
  for (const m of output.matchAll(/\(fail\)\s*([^\n]+)/g)) {
    const name = m[1].trim();
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

/**
 * Прогоняет тесты проекта в пределах бюджета аудита и разбирает сводку раннера.
 *
 * Таймаут/отсутствие сводки — `inconclusive`, а не «прошло»: завершение на нём
 * не блокируется, но вердикт честный (спека 2026-10-30).
 *
 * @param baseDir корень проекта; @param opts.budgetMs переопределение бюджета (тесты).
 * @returns статус, счётчики, причина inconclusive и длительность.
 */
export async function runTests(
  baseDir: string,
  opts: { budgetMs?: number } = {},
): Promise<TestRunCheck> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? AUDIT_TEST_RUN_BUDGET_MS;
  const command = resolveTestCommand(baseDir);
  const entry = processRegistry.start(command, baseDir);
  const exited = await processRegistry.waitForExit(entry.id, budgetMs);
  const output = entry.log.join("\n");
  const spawnError = entry.spawnError;
  processRegistry.remove(entry.id);
  const durationMs = Date.now() - started;
  const base = { checked: true, command, durationMs };

  if (!exited) {
    // Раннер не довершён: результат неизвестен, «прошло» утверждать нельзя.
    return {
      ...base,
      passed: false,
      status: "inconclusive",
      failed: 0,
      passedCount: 0,
      detail: `inconclusive: runner did not finish within ${Math.round(budgetMs / 1000)}s — result unknown, not a pass`,
    };
  }
  if (spawnError) {
    // Раннер вообще не стартовал — это не фейл тестов и не успех.
    return {
      ...base,
      passed: false,
      status: "inconclusive",
      failed: 0,
      passedCount: 0,
      detail: `inconclusive: runner failed to start (${spawnError.slice(0, 150)})`,
    };
  }

  const run = detectTestResults(output);
  if (!run) {
    // Нет узнаваемой сводки раннера. Ненулевой exit — прогон (или раннер) упал:
    // аудит его пропускать не должен; репортим "как минимум один фейл", т.к.
    // посчитать не можем. Exit 0 с неузнанным выводом — прогон не доказан.
    if (entry.exitCode === 0) {
      return {
        ...base,
        passed: false,
        status: "inconclusive",
        failed: 0,
        passedCount: 0,
        detail: `inconclusive: exit 0 without a recognized runner summary — ${output.slice(0, 200).trim()}`,
      };
    }
    return {
      ...base,
      passed: false,
      status: "failed",
      failed: 1,
      passedCount: 0,
      detail: output.slice(0, 200).trim(),
    };
  }

  const names = extractFailingNames(output);
  return {
    ...base,
    passed: run.failed === 0,
    status: run.failed === 0 ? "passed" : "failed",
    failed: run.failed,
    passedCount: run.passed,
    detail: names.length
      ? names.join("; ")
      : run.summary || `${run.failed} failed / ${run.passed} passed`,
  };
}

/** Кап числа файлов в отпечатке дерева: больше — отпечаток не считаем (кэш off). */

/** Первая строка `error TS…` из вывода tsc, или null если нет/inconclusive. */
export function parseTypecheckErrors(output: string): string | null {
  const line = output.split("\n").find((l) => /error TS\d+/.test(l));
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Находит ближайший корень проекта с tsconfig.json.
 *
 * Агент часто создаёт проект во вложенной папке baseDir (напр. `bicycle-shop/`),
 * и tsconfig лежит в `baseDir/bicycle-shop/`; старый гейт `existsSync(baseDir/tsconfig.json)`
 * молча скипал финальный typecheck — аудит проходил при десятках tsc-ошибок
 * (было в обеих разобранных сессиях). Обходит каждого кандидата (baseDir плюс
 * резолвленные файлы шагов) вверх до ближайшего tsconfig.json, предпочитая
 * мельчайшее попадание (проект baseDir бьёт шальной tsconfig выше). Null, если
 * tsconfig недостижим. `existingFiles` — резолвленные абсолютные пути
 * (относительные токены резолвились бы от cwd процесса, не от baseDir).
 */
export function findTypecheckRoot(baseDir: string, existingFiles: string[] = []): string | null {
  const candidates: string[] = [baseDir, ...existingFiles];
  let best: { depth: number; root: string } | null = null;
  for (const start of candidates) {
    let dir = resolve(start);
    for (let depth = 0; depth <= 10; depth++) {
      if (existsSync(join(dir, "tsconfig.json"))) {
        if (!best || depth < best.depth) best = { depth, root: dir };
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return best?.root ?? null;
}

/** Прогоняет `tsc --noEmit --skipLibCheck` (бюджет аудита). Null, если проверить нельзя/таймаут. */
export async function runTypecheck(baseDir: string): Promise<string | null> {
  // Локальный tsc напрямую: npx-обёртка добавляет секунды и без локального
  // пакета уходит в сеть. Нет tsc — проверка невозможна, не блокируем.
  const tsc = resolveTscCommand(baseDir);
  if (!tsc) return null;
  const entry = processRegistry.start(`${tsc} --noEmit --skipLibCheck`, baseDir);
  const exited = await processRegistry.waitForExit(entry.id, AUDIT_TYPECHECK_BUDGET_MS);
  const output = entry.log.join("\n");
  processRegistry.remove(entry.id);
  // DEBT(audit-typecheck-inconclusive): таймаут tsc и «ошибок нет» одинаково
  // возвращают null — в сводке/`session.jsonl` они неразличимы (INV-15).
  // Оплата — отдельная волна: нужен тип результата вместо string|null.
  if (!exited) return null;
  return parseTypecheckErrors(output);
}
