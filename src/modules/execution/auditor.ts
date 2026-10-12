// Финальный аудитор: файлы done-шагов, тесты, typecheck, сводка честности.
import { existsSync, readdirSync } from "fs";
import type { Dirent } from "fs";
import { resolve, join, basename } from "path";
import { t } from "../../i18n/index";
import type { Plan } from "./planner";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { toForwardSlash } from "../../tools/path-utils";
import {
  SKIP_DIRS,
  findTestFile,
  findTypecheckRoot,
  runTests,
  runTypecheck,
} from "./audit-runners";
import type { TestRunCheck } from "./audit-runners";

export { parseTypecheckErrors } from "./audit-runners";

const MASS_EDIT_THRESHOLD = 10;

/** Кап глубины обхода поддерева для резолва файлов. */
const RESOLVE_MAX_DEPTH = 8;

/**
 * Резолвит файловый токен шага плана в существующий файл.
 *
 * Описание шага часто называет файл голым basename ("App.tsx") или частично
 * префиксным путём ("src/App.tsx"), а реальный файл лежит во вложенной папке
 * проекта относительно baseDir агента (напр. `bicycle-shop/src/App.tsx`).
 * Наивный резолв от baseDir репортит файл пропавшим — было в ses_mssl5izw:
 * финальный audit-gate вечно реджектил полностью готовую задачу с "1 files
 * missing", загоняя модель в read/retry-петлю.
 *
 * Стратегия: сначала точный резолв, затем ограниченный обход поддерева с
 * матчем точного basename или суффикса пути ("App.tsx" и "src/App.tsx"
 * находят "bicycle-shop/src/App.tsx").
 */
export function findExistingFile(baseDir: string, filePath: string): string | null {
  const direct = resolve(baseDir, filePath);
  if (existsSync(direct)) return direct;

  const name = basename(filePath).toLowerCase();
  const suffix = toForwardSlash(filePath).toLowerCase();
  let found: string | null = null;

  const walk = (dir: string, depth: number): void => {
    if (found || depth > RESOLVE_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (
        e.name.toLowerCase() === name ||
        toForwardSlash(full)
          .toLowerCase()
          .endsWith(`/${suffix}`)
      ) {
        found = full;
        return;
      }
    }
  };

  walk(baseDir, 0);
  return found;
}

/** Результат аудита: фейлы файлов, тесты, typecheck, сводка, варнинги. */
export interface AuditResult {
  passed: boolean;
  missingFiles: string[];
  /** Done-шаги kind=delete, чьи именованные файлы всё ещё существуют. */
  leftoverFiles: string[];
  createdFiles: string[];
  modifiedFiles: string[];
  summary: string;
  massEditWarning: string | null;
  testRun: TestRunCheck | null;
  /** Первая строка `error TS…` из реального `tsc --noEmit`, или null. */
  typecheckError: string | null;
}

/** Аудитор: проверяет done-шаги плана — файлы, тесты, typecheck. */
export class Auditor {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Аудитит план: файлы done-шагов, реальный прогон тестов, typecheck, сводка. */
  async audit(plan: Plan): Promise<AuditResult> {
    // Существования требуем только с файлов шагов, которые модель заявила
    // готовыми. Скипнутые/пендинг шаги в "missing files" вклада не дают
    // (было: проза скипнутого шага с "type.ts" вечно реджектила готовую
    // задачу гейтом с "1 files missing").
    const doneCreate = plan.steps.filter((s) => s.status === "done" && s.kind !== "delete");
    const doneDelete = plan.steps.filter((s) => s.status === "done" && s.kind === "delete");
    const createText = doneCreate.map((s) => s.description.replace(/\([^)]*\)/g, " ")).join(" ");
    const deleteText = doneDelete.map((s) => s.description.replace(/\([^)]*\)/g, " ")).join(" ");
    // Токены файлов извлекаем ТЕМ ЖЕ общим фильтром, что фактическая проверка
    // галлюцинаций (js-identifiers.ts). URL вырезаем заранее, чтобы hostname /
    // https://host/repo.git в описании шага не репортился пропавшим файлом
    // (было: git-remote план флаговал `whom-pointing-jewel-maine.trycloudflare.com`).
    const createFiles = extractFileLikeTokens(stripUrls(createText));
    const deleteFiles = extractFileLikeTokens(stripUrls(deleteText));

    const missingFiles: string[] = [];
    const existingFiles: string[] = [];
    const leftoverFiles: string[] = [];

    for (const filePath of createFiles) {
      const resolved = findExistingFile(this.baseDir, filePath);
      if (resolved) {
        // Храним резолвленный абсолютный путь: findTypecheckRoot идёт от него
        // вверх к ближайшему tsconfig, а относительный токен резолвился бы
        // от cwd процесса вместо baseDir.
        existingFiles.push(resolved);
      } else {
        missingFiles.push(filePath);
      }
    }
    // Done-шаг kind=delete требует ОТСУТСТВИЯ именованных файлов.
    for (const filePath of deleteFiles) {
      if (findExistingFile(this.baseDir, filePath)) {
        leftoverFiles.push(filePath);
      }
    }

    // Реальный прогон тестов: слову модели (и exit-кодам) не верим — реально
    // исполняем тесты и смотрим сводку раннера. Ловит финальные "all 7
    // passing ✅", прячущие 3 упавших.
    //
    // Решение EVIDENCE-based (тестовый файл есть на диске), не классификация
    // прозы шагов по ключевым словам: правило #10 запрещает выводить требования
    // из слов "test"/"тест" (план с тестами, но без такого слова, скипал аудит;
    // постороннее "testing" форсило 90s-прогон).
    let testRun: TestRunCheck | null = null;
    if (findTestFile(this.baseDir)) {
      try {
        testRun = await runTests(this.baseDir);
      } catch {
        testRun = null; // сбой инфры — на нём не блокируемся
      }
    }

    // Реальный typecheck: аудит ловит "сборка сломана", даже если все файлы на
    // месте (было: удаление .js оставило .tsx-исходники с 11 tsc-ошибками, а
    // агент заявил успех). Гоняется, только если tsconfig.json достижим от
    // baseDir или резолвленных файлов шагов И файловые проверки уже прошли —
    // обречённому на missing/leftover аудиту 90s tsc-спавн не платим.
    // Inconclusive-результаты не блокируют.
    let typecheckError: string | null = null;
    if (missingFiles.length === 0 && leftoverFiles.length === 0) {
      const root = findTypecheckRoot(this.baseDir, existingFiles);
      if (root) {
        try {
          typecheckError = await runTypecheck(root);
        } catch {
          typecheckError = null;
        }
      }
    }

    const doneSteps = plan.steps.filter((s) => s.status === "done").length;
    // done + skipped — оба осознанные терминальные состояния: `done` заявляет
    // работу, `skipped` документирует решение, что шаг не нужен (задокументированная
    // лазейка deliverable-gate). Ни то, ни другое — не ложь для аудита: план с
    // легитимно скипнутым шагом обязан проходить (было: скипнутый шаг 1 вечно
    // держал задачу реджектнутой).
    const terminalSteps = plan.steps.filter(
      (s) => s.status === "done" || s.status === "skipped",
    ).length;
    const totalSteps = plan.steps.length;

    const auditedFiles = [...new Set([...createFiles, ...deleteFiles])];
    let massEditWarning: string | null = null;
    if (auditedFiles.length > MASS_EDIT_THRESHOLD) {
      massEditWarning = t("exec.mass_edit_warning", {
        count: String(auditedFiles.length),
      });
    }

    const testsFailing = testRun !== null && !testRun.passed;
    const typecheckFailing = typecheckError !== null;
    const passed =
      missingFiles.length === 0 && leftoverFiles.length === 0 && !testsFailing && !typecheckFailing;
    // Сводка "Task complete ✓" для незаконченного плана — ложь, которую модель
    // читает как зелёный свет (было: audit-gate инжектил "[✓] Task complete:
    // 1/3 steps done" при 2 пендинг шагах). Сводка заявляет завершение, только
    // если реально done каждый шаг.
    const stepsPending = terminalSteps < totalSteps;

    let summary: string;
    if (missingFiles.length > 0) {
      summary = t("exec.audit_fail", {
        done: doneSteps,
        total: totalSteps,
        files: missingFiles.length,
      });
    } else if (leftoverFiles.length > 0) {
      summary = t("exec.audit_leftovers", {
        done: doneSteps,
        total: totalSteps,
        files: leftoverFiles.length,
      });
    } else if (testsFailing) {
      summary = t("exec.audit_fail_tests", {
        done: doneSteps,
        total: totalSteps,
        failed: String(testRun!.failed),
        passed: String(testRun!.passedCount),
        detail: testRun!.detail,
      });
    } else if (typecheckFailing) {
      summary = t("exec.audit_fail_typecheck", {
        done: doneSteps,
        total: totalSteps,
        missing: String(missingFiles.length),
        typeError: typecheckError!,
      });
    } else if (stepsPending) {
      summary = t("exec.audit_pending", {
        done: doneSteps,
        total: totalSteps,
      });
    } else {
      summary = t("exec.audit_pass", {
        done: doneSteps,
        total: totalSteps,
        files: existingFiles.length,
      });
    }

    return {
      passed,
      missingFiles,
      leftoverFiles,
      createdFiles: existingFiles,
      modifiedFiles: [],
      summary,
      massEditWarning,
      testRun,
      typecheckError,
    };
  }
}
