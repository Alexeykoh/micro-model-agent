// Финальный аудитор: файлы done-шагов, тесты, typecheck, сводка честности.
import { existsSync, readdirSync } from "fs";
import type { Dirent } from "fs";
import { resolve, join, basename } from "path";
import { t } from "../../i18n/index";
import type { Plan } from "./planner";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { toForwardSlash } from "../../tools/path-utils";
import { SKIP_DIRS, findTypecheckRoot, runTypecheck } from "./audit-runners";
import type { TestRunCheck } from "./audit-runners";
import { resolveTestRun, testRunNote } from "./audit-test-run";

export { parseTypecheckErrors } from "./audit-runners";

const MASS_EDIT_THRESHOLD = 10;

/** Опции аудита, которые знает вызывающий (контракт — спека бюджета тестов). */
export interface AuditOptions {
  /**
   * Были ли за ход успешные файловые мутации. `false` — полный тест-прогон
   * скипается (`skipped: no file mutations this turn`); `undefined` — неизвестно,
   * проверяем (обратная совместимость).
   */
  mutated?: boolean;
}

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
/** Имя для сверки «создан/удалён»: basename без ведущих `_`/`.`. */
function artifactName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = (normalized.split("/").pop() ?? normalized).toLowerCase();
  return base.replace(/^[_.]+/, "");
}

/**
 * Временный ли это артефакт: scratch-файл, который план уберёт после чтения.
 * Существовать на финише он не обязан.
 *
 * @param token путь/имя файла из описания шага.
 * @returns true для `_scratch`, `/tmp/…`, `*.tmp`, `.mma/…` и подобных.
 */
export function isTransientArtifact(token: string): boolean {
  const normalized = token.replace(/\\/g, "/").toLowerCase();
  const base = normalized.split("/").pop() ?? "";
  if (!base) return false;
  if (base.startsWith("_") || base.startsWith(".")) return true;
  if (/^(tmp|temp)[-_.]/.test(base)) return true;
  if (/\.(tmp|log|pid|bak|orig|swp|dump|out)$/.test(base)) return true;
  return (
    normalized.includes("/tmp/") ||
    normalized.includes("/temp/") ||
    normalized.startsWith("tmp/") ||
    normalized.startsWith("temp/") ||
    normalized.includes(".mma/") ||
    normalized.includes("node_modules/")
  );
}

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
        toForwardSlash(full).toLowerCase().endsWith(`/${suffix}`)
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
  /** Пометка прогона для лога/сводки: скип, inconclusive, кэш (иначе null). */
  testNote: string | null;
  /** Первая строка `error TS…` из реального `tsc --noEmit`, или null. */
  typecheckError: string | null;
}

/** Аудитор: проверяет done-шаги плана — файлы, тесты, typecheck. */
export class Auditor {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Аудитит план: файлы done-шагов, реальный прогон тестов, typecheck, сводка.
   * @param plan план задачи; @param opts мутации хода (см. `AuditOptions`).
   */
  async audit(plan: Plan, opts: AuditOptions = {}): Promise<AuditResult> {
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
    // Временный артефакт — не поставка: шаг «извлечь плагин в _sisi.js и
    // прочитать» заканчивается удалением файла, и требовать его существования
    // на финише — ложный провал (ses_mvpk4zjl: готовый диагноз отклонён с
    // «[✗] 1 файлов отсутствует»). Плюс всё, что план сам объявил удалённым.
    // Сверяем по basename: шаг «извлечь sisi.js в _sisi.js» называет файл без
    // подчёркивания, а шаг удаления — с ним; это один и тот же артефакт.
    const deletedNames = new Set(
      extractFileLikeTokens(stripUrls(deleteText)).map((f) => artifactName(f)),
    );
    const createFiles = extractFileLikeTokens(stripUrls(createText)).filter(
      (f) => !isTransientArtifact(f) && !deletedNames.has(artifactName(f)),
    );
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

    // Реальный прогон тестов: слову модели (и exit-кодам) не верим — смотрим
    // сводку раннера. Решение EVIDENCE-based (тестовый файл на диске), не по
    // словам шага (правило #10). Бюджет (спека 2026-10-30): без файловых
    // мутаций за ход прогон не нужен, неизменное дерево — из кэша, таймаут —
    // inconclusive (не «прошло»).
    const testRun = await resolveTestRun(this.baseDir, { mutated: opts.mutated });
    const testNote = testRunNote(testRun);

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

    // Блокирует только реальный фейл: `inconclusive` и `skipped` — не фейл,
    // завершение на них по-прежнему не блокируется (но видно в `testNote`).
    const testsFailing = testRun !== null && testRun.status === "failed";
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
      testNote,
      typecheckError,
    };
  }
}
