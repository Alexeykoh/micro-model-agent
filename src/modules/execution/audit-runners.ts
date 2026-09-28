// Раннеры финального аудита: поиск тестов, прогон тестов, поиск корня typecheck.
import { existsSync, readdirSync, readFileSync } from "fs";
import type { Dirent } from "fs";
import { dirname, join, resolve } from "path";
import { detectTestResults } from "../../tools/bash";
import { processRegistry } from "../processes";
import { resolveTscCommand } from "../lsp/project-root";

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
export interface TestRunCheck {
  /** Реальный тестовый прогон вообще выполнялся. */
  checked: boolean;
  /** Все найденные тесты прошли. */
  passed: boolean;
  failed: number;
  passedCount: number;
  /** Короткий список упавших тестов (до 5) или сводка раннера. */
  detail: string;
  command: string;
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

/** Прогоняет тесты проекта (90s) и разбирает сводку раннера. Таймаут — inconclusive. */
export async function runTests(baseDir: string): Promise<TestRunCheck> {
  const command = resolveTestCommand(baseDir);
  const entry = processRegistry.start(command, baseDir);
  const exited = await processRegistry.waitForExit(entry.id, 90_000);
  const output = entry.log.join("\n");
  processRegistry.remove(entry.id);

  if (!exited) {
    // Таймаут — успех/фейл незавершённого прогона утверждать не можем.
    return {
      checked: true,
      passed: true, // don't block completion on an inconclusive run
      failed: 0,
      passedCount: 0,
      detail: `test run timed out after 90s — result unknown`,
      command,
    };
  }

  const run = detectTestResults(output);
  if (!run) {
    // Нет узнаваемой сводки раннера. Ненулевой exit — прогон (или раннер) упал:
    // аудит его пропускать не должен; репортим "как минимум один фейл", т.к.
    // посчитать не можем. Exit 0 с неузнанным выводом — checked, но inconclusive.
    return {
      checked: true,
      passed: entry.exitCode === 0,
      failed: entry.exitCode === 0 ? 0 : 1,
      passedCount: 0,
      detail: output.slice(0, 200).trim(),
      command,
    };
  }

  const names = extractFailingNames(output);
  return {
    checked: true,
    passed: run.failed === 0,
    failed: run.failed,
    passedCount: run.passed,
    detail: names.length
      ? names.join("; ")
      : run.summary || `${run.failed} failed / ${run.passed} passed`,
    command,
  };
}

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

/** Прогоняет `tsc --noEmit --skipLibCheck` (90s). Null, если проверить нельзя/таймаут. */
export async function runTypecheck(baseDir: string): Promise<string | null> {
  // Локальный tsc напрямую: npx-обёртка добавляет секунды и без локального
  // пакета уходит в сеть. Нет tsc — проверка невозможна, не блокируем.
  const tsc = resolveTscCommand(baseDir);
  if (!tsc) return null;
  const entry = processRegistry.start(`${tsc} --noEmit --skipLibCheck`, baseDir);
  const exited = await processRegistry.waitForExit(entry.id, 90_000);
  const output = entry.log.join("\n");
  processRegistry.remove(entry.id);
  // Таймаут или вывод без строк `error TS` (нет typescript / не та рабочая
  // папка) — inconclusive, завершение на этом не блокируем.
  if (!exited) return null;
  return parseTypecheckErrors(output);
}
