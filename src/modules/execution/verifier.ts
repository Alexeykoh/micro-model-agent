// Верификатор шагов: файлы, синтаксис, скрипты, typecheck, success_criteria.
import { existsSync, readFileSync } from "fs";
import { resolve, extname, dirname, join } from "path";
import { spawn } from "child_process";
import { t } from "../../i18n/index";
import type { MoEPlan, MoESubtask } from "./types";
import type { StepKind } from "./planner";
import type { AppConfig } from "../../config/types";
import { validateExpertConfig } from "../../config/experts";
import { findProjectRoot, resolveTscCommand } from "../lsp/project-root";
import { extractFileLikeTokens, stripUrls } from "../hallucination/js-identifiers";
import { findExistingFile } from "./auditor";
import { findTypecheckRoot } from "./audit-runners";
import { killTree } from "../processes/kill-tree";

/** Один пункт проверки: прошёл ли + сообщение. */
export interface VerificationItem {
  passed: boolean;
  message: string;
}

/** Результат проверки machine-readable success_criteria одной подзадачи. */
export interface SubtaskCriteriaResult {
  errors: string[];
  /** LLM-only критерии (не машиночитаемые) — отдаются варнингами. */
  warnings: string[];
  details: VerificationItem[];
}

/** Результат верификации шага: прошёл, синтаксис валиден, фейлы, флаг "без файлов". */
export interface StepVerificationResult {
  passed: boolean;
  syntaxValid: boolean;
  failed: VerificationItem[];
  noFiles?: boolean;
}

/** Результат верификации MoE-манифеста: успех, ошибки, варнинги, детали. */
export interface MoEVerificationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  details: VerificationItem[];
}

/** Верификатор шагов и MoE-планов: файлы, синтаксис, скрипты, tsc, критерии. */
export class StepVerifier {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Проверяет существование файла (с nested-резолвером findExistingFile). */
  async checkFileExists(path: string): Promise<VerificationItem> {
    // Nested-aware (тот же резолвер, что в verifyStep): проект в
    // `baseDir/proj/` нельзя репортить пропавшим, если файл ниже.
    const resolved = findExistingFile(this.baseDir, path);
    const exists = !!resolved;
    return {
      passed: exists,
      message: exists ? t("verify.file_exists", { path }) : t("verify.file_not_found", { path }),
    };
  }

  /** Запускает `bun run <script>` (60s), возвращает пункт проверки. */
  async runScript(scriptName: string): Promise<VerificationItem> {
    try {
      await this.runAsync(`bun run ${scriptName}`, this.baseDir, 60_000);
      return { passed: true, message: t("verify.script_passed", { script: scriptName }) };
    } catch (e: any) {
      return {
        passed: false,
        message: t("verify.script_failed", { script: scriptName, message: e.message }),
      };
    }
  }

  /** Проектный typecheck (tsc --noEmit); без tsconfig/tsc — пропуск, не фейл. */
  async runTypeCheck(existingFiles: string[] = []): Promise<VerificationItem> {
    // Корень проекта резолвим и по артефактам: проект во вложенном
    // `baseDir/proj/` надо типчекать, а не скипать ("No tsconfig.json found") —
    // старый поиск только от baseDir его не видел.
    const root = findTypecheckRoot(this.baseDir, existingFiles) ?? this.baseDir;
    const tsconfigPath = join(root, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      return { passed: true, message: t("verify.typecheck_skipped_no_tsconfig") };
    }
    const tsc = resolveTscCommand(root);
    if (!tsc) return { passed: true, message: t("verify.typecheck_skipped_no_tsc") };
    try {
      await this.runAsync(`${tsc} --noEmit`, root, 60_000);
      return { passed: true, message: t("verify.typecheck_passed") };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message;
      return {
        passed: false,
        message: t("verify.typecheck_failed", { error: stderr.slice(0, 500) }),
      };
    }
  }

  /**
   * Типчекает конкретный файл, резолвя корень проекта от РАСПОЛОЖЕНИЯ ФАЙЛА
   * (не от baseDir агента). Для вложенных раскладок (`baseDir/proj/` со своим
   * tsconfig.json) старая проверка от baseDir молча скипала каждую ошибку типов
   * (было в ses_mst2r0r5: ноль type feedback за всю сессию). Маркеры зеркалят
   * конфиг TypeScript LSP-сервера.
   */
  async runTypeCheckForFile(filePath: string): Promise<VerificationItem> {
    const projectRoot = findProjectRoot(filePath, this.baseDir, ["tsconfig.json", "package.json"]);
    const tsconfigPath = join(projectRoot, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      return { passed: true, message: t("verify.typecheck_skipped_no_tsconfig") };
    }
    const tsc = resolveTscCommand(projectRoot);
    if (!tsc) return { passed: true, message: t("verify.typecheck_skipped_no_tsc") };
    try {
      await this.runAsync(`${tsc} --noEmit --skipLibCheck`, projectRoot, 60_000);
      return { passed: true, message: t("verify.typecheck_passed") };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message;
      return {
        passed: false,
        message: t("verify.typecheck_failed", { error: stderr.slice(0, 500) }),
      };
    }
  }

  /** Запускает `test`-скрипт проекта; без package.json/скрипта — пропуск. */
  async runTests(): Promise<VerificationItem> {
    const pkgPath = resolve(this.baseDir, "package.json");
    if (!existsSync(pkgPath)) {
      return { passed: true, message: t("verify.tests_skipped_no_package") };
    }
    try {
      const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
      if (!pkg.scripts?.test) {
        return { passed: true, message: t("verify.tests_skipped_no_script") };
      }
    } catch {
      /* fall through — пробуем запустить */
    }
    return this.runScript("test");
  }

  /** Проверяет существование списка файлов-артефактов (параллельно). */
  async verifyArtifactFiles(files: string[]): Promise<VerificationItem[]> {
    return Promise.all(files.map((f) => this.checkFileExists(f)));
  }

  /**
   * Проверяет machine-readable success_criteria подзадачи ДО решения о merge
   * (Plan 5.1). Поддержаны формы:
   * - `file-exists:<path>`
   * - `substring-in-file:<path>:<text>`
   * - `command-exit-0:<command>`
   * Остальное — LLM-only критерий: варнинг (не ошибка), чтобы Router всё равно
   * видел его в контексте.
   */
  async verifySubtaskCriteria(subtask: MoESubtask): Promise<SubtaskCriteriaResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const details: VerificationItem[] = [];

    for (const criterion of subtask.success_criteria || []) {
      const sep = criterion.indexOf(":");
      if (sep <= 0) {
        warnings.push(`Subtask "${subtask.id}": non-machine criterion "${criterion}" (LLM-only)`);
        continue;
      }
      const kind = criterion.slice(0, sep);
      const rest = criterion.slice(sep + 1);

      if (kind === "file-exists") {
        const check = await this.checkFileExists(rest);
        details.push(check);
        if (!check.passed) errors.push(`[${subtask.id}] ${check.message}`);
        continue;
      }

      if (kind === "substring-in-file") {
        const colon = rest.indexOf(":");
        if (colon <= 0) {
          warnings.push(
            `Subtask "${subtask.id}": malformed substring-in-file criterion "${criterion}"`,
          );
          continue;
        }
        const path = rest.slice(0, colon);
        const needle = rest.slice(colon + 1);
        const resolved = resolve(this.baseDir, path);
        if (!existsSync(resolved)) {
          const item = { passed: false, message: t("verify.file_not_found", { path }) };
          details.push(item);
          errors.push(`[${subtask.id}] ${item.message}`);
          continue;
        }
        const content = readFileSync(resolved, "utf-8");
        const passed = content.includes(needle);
        details.push({ passed, message: `substring "${needle}" in ${path}: ${passed}` });
        if (!passed) errors.push(`[${subtask.id}] "${needle}" not found in ${path}`);
        continue;
      }

      if (kind === "command-exit-0") {
        try {
          await this.runAsync(rest, this.baseDir, 30_000);
          details.push({ passed: true, message: `command ok: ${rest}` });
        } catch (e: any) {
          const item = {
            passed: false,
            message: `command failed: ${rest} (${String(e.message).slice(0, 200)})`,
          };
          details.push(item);
          errors.push(`[${subtask.id}] ${item.message}`);
        }
        continue;
      }

      warnings.push(`Subtask "${subtask.id}": unknown criterion kind "${kind}" (LLM-only)`);
    }

    return { errors, warnings, details };
  }

  /** Верифицирует MoE-манифест: эксперты, typecheck, файлы и критерии подзадач. */
  async verifyMoEManifest(
    plan: MoEPlan,
    config: AppConfig,
    allToolTags: string[],
  ): Promise<MoEVerificationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const details: VerificationItem[] = [];

    const expertErrors = validateExpertConfig(config, allToolTags);
    for (const err of expertErrors) {
      errors.push(err);
      details.push({ passed: false, message: err });
    }

    const existingArtifacts = plan.subtasks
      .flatMap((s) => s.allowed_files || [])
      .map((f) => findExistingFile(this.baseDir, f))
      .filter((f): f is string => !!f);
    const tscResult = await this.runTypeCheck(existingArtifacts);
    details.push(tscResult);
    if (!tscResult.passed) {
      errors.push(tscResult.message);
    }

    for (const sub of plan.subtasks) {
      const fileChecks = await this.verifyArtifactFiles(sub.allowed_files || []);
      for (const check of fileChecks) {
        details.push(check);
        if (!check.passed) {
          errors.push(check.message);
        }
      }

      // Machine-readable success_criteria (Plan 5.1) — проверяются до merge.
      const criteria = await this.verifySubtaskCriteria(sub);
      errors.push(...criteria.errors);
      warnings.push(...criteria.warnings);
      details.push(...criteria.details);
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      details,
    };
  }

  /** Верифицирует шаг: файлы из описания существуют (+синтаксис; delete — наоборот). */
  async verifyStep(stepDescription: string, kind?: StepKind): Promise<StepVerificationResult> {
    const fileMatches = extractFileLikeTokens(stripUrls(stepDescription));

    // Нет именованных файлов — шаг непроверяем по существованию. НЕ пропускаем
    // тривиально (пустой every() = true); сигналим noFiles, чтобы тул вёл
    // модель к настоящей проверке.
    if (fileMatches.length === 0) {
      return { passed: false, syntaxValid: true, failed: [], noFiles: true };
    }

    const results: VerificationItem[] = [];
    let syntaxValid = true;

    for (const filePath of fileMatches) {
      const resolved = findExistingFile(this.baseDir, filePath);
      const exists = !!resolved;

      if (kind === "delete") {
        // Для delete-шагов: отсутствие файла — pass
        results.push({
          passed: !exists,
          message: exists
            ? t("verify.file_still_exists", { path: filePath })
            : t("verify.file_not_found", { path: filePath }),
        });
        // Удалённый файл синтаксически не проверяем
        continue;
      }

      // Create-шаги: файл обязан существовать + валидный синтаксис
      if (!exists) {
        results.push({ passed: false, message: t("verify.file_not_found", { path: filePath }) });
        continue;
      }
      results.push({ passed: true, message: t("verify.file_exists", { path: filePath }) });

      if (!(await this.validateSyntax(resolved))) {
        syntaxValid = false;
        results.push({ passed: false, message: t("verify.syntax_error", { path: filePath }) });
      }
    }

    return {
      passed: results.every((r) => r.passed),
      syntaxValid,
      failed: results.filter((r) => !r.passed),
      noFiles: false,
    };
  }

  private async validateSyntax(filePath: string): Promise<boolean> {
    const ext = extname(filePath);

    if (ext === ".ts" || ext === ".tsx" || ext === ".cts" || ext === ".mts") {
      // Локальный tsc, а не npx: npx без локального пакета уходит в сеть и
      // висит секундами. Нет tsc — пропускаем проверку (как и раньше «not
      // found → true»), но мгновенно.
      const tsc = resolveTscCommand(dirname(filePath));
      if (!tsc) return true;
      try {
        // Путь в кавычках — команды идут через shell и ломаются на пробелах.
        await this.runAsync(`${tsc} --noEmit --skipLibCheck "${filePath}"`, this.baseDir, 20000);
        return true;
      } catch (err: any) {
        if (
          err.status === 127 ||
          err.message.includes("not found") ||
          err.message.includes("ENOENT")
        ) {
          return true;
        }
        const stderr = err.stderr?.toString() || "";
        if (stderr.includes("error TS") && !stderr.includes("Cannot find module")) {
          return false;
        }
        return true;
      }
    }

    if (ext === ".js" || ext === ".jsx" || ext === ".cjs" || ext === ".mjs") {
      try {
        await this.runAsync(`node --check "${filePath}"`, this.baseDir, 5000);
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Запускает команду асинхронно (не блокируя event loop) и резолвится на
   * выходе. На ненулевой exit или таймаут — reject с захваченными stderr/stdout.
   */
  private runAsync(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      const timer = setTimeout(() => {
        // Убиваем всё дерево: при shell:true child.kill() останавливает только
        // shell, а реальный внук tsc/node продолжает висеть.
        killTree(child);
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const err: any = new Error(`Command failed with exit code ${code}`);
          err.stdout = stdout;
          err.stderr = stderr;
          err.status = code;
          reject(err);
        }
      });
    });
  }
}
