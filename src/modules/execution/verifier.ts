// Верификатор шагов: файлы, синтаксис, скрипты, typecheck, success_criteria.
import { existsSync } from "fs";
import { resolve, join } from "path";
import { spawn } from "child_process";
import { t } from "../../i18n/index";
import type { StepKind } from "./planner";
import { findProjectRoot, resolveTscCommand } from "../lsp/project-root";
import { extractFileLikeTokens, stripUrls } from "../../core/hallucination/js-identifiers";
import { findExistingFile } from "./auditor";
import { findTypecheckRoot } from "./audit-runners";
import { killTree } from "../processes/kill-tree";
import { settleChildClose } from "../../utils/child-run";
import { resolveCheckPath } from "./check-path";
import { checkSyntax } from "./syntax-check";
import type { PathSecurityConfig } from "../../config/types";
import type { ToolScope } from "../../tools/types";
import { evaluateCriteria } from "./verifier-criteria";
import { checkFileModified as checkFileModifiedImpl, snapshotFile as snapshotFileImpl } from "./file-modified-check";
import type { CriteriaResult, VerificationItem } from "./verifier-criteria";

export type { CriteriaResult, VerificationItem } from "./verifier-criteria";

/** Результат верификации шага: прошёл, синтаксис валиден, фейлы, флаг "без файлов". */
export interface StepVerificationResult {
  passed: boolean;
  syntaxValid: boolean;
  failed: VerificationItem[];
  noFiles?: boolean;
}

/** Результат верификации манифеста: успех, ошибки, варнинги, детали. */
export interface ManifestVerificationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  details: VerificationItem[];
}

/** Верификатор шагов плана: файлы, синтаксис, скрипты, tsc, критерии. */
export class StepVerifier {
  private baseDir: string;
  /** Отчёт о fail-open деградации (INV-15): «нет tsc» ≠ «синтаксис валиден». */
  private onDegrade?: (operation: string, reason: string) => void;
  /** Политика путей: тот же вердикт, что у тулов (INV-9/10); undefined — легаси. */
  private pathSecurity?: PathSecurityConfig;

  constructor(
    baseDir: string,
    onDegrade?: (operation: string, reason: string) => void,
    pathSecurity?: PathSecurityConfig,
  ) {
    this.baseDir = baseDir;
    this.onDegrade = onDegrade;
    this.pathSecurity = pathSecurity;
  }

  /** Зафиксировать пропущенную (не выполненную) проверку, оставив причину. */
  private degrade(operation: string, reason: string): void {
    this.onDegrade?.(operation, reason);
  }

  /** Проверяет существование файла (nested-резолвер + политика путей). */
  async checkFileExists(path: string, scope?: ToolScope): Promise<VerificationItem> {
    const check = resolveCheckPath(this.baseDir, path, scope, this.pathSecurity);
    if (check.blocked) return { passed: false, message: check.blocked };
    // Контракт `file-exists:` проверяет заявленный путь, не чужой basename
    // (дефект A); суффикс пути сохраняет вложенный проект (`src/a.ts`).
    const exists = !!findExistingFile(this.baseDir, check.path, { mode: "suffix" });
    return {
      passed: exists,
      message: exists ? t("verify.file_exists", { path }) : t("verify.file_not_found", { path }),
    };
  }

  /** Снапшот контента для `file-modified:` на create/re-plan. */
  async snapshotFile(path: string, scope?: ToolScope): Promise<string | null> {
    return snapshotFileImpl(this.baseDir, path, scope, this.pathSecurity);
  }

  /** Жёсткая проверка `file-modified:` на done: контент отличается от снапшота. */
  async checkFileModified(
    path: string,
    baseline: string | null | undefined,
    scope?: ToolScope,
  ): Promise<VerificationItem> {
    return checkFileModifiedImpl(this.baseDir, path, baseline, scope, this.pathSecurity);
  }

  /** Запускает `bun run <script>` (60s), возвращает пункт проверки. */
  async runScript(scriptName: string): Promise<VerificationItem> {
    try {
      await this.runAsync(`bun run ${scriptName}`, this.baseDir, 60_000);
      return { passed: true, message: t("verify.script_passed", { script: scriptName }) };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        passed: false,
        message: t("verify.script_failed", { script: scriptName, message }),
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
      this.degrade("verify.typecheck", `no tsconfig.json at ${root}; typecheck skipped`);
      return { passed: true, message: t("verify.typecheck_skipped_no_tsconfig") };
    }
    const tsc = resolveTscCommand(root);
    if (!tsc) {
      this.degrade("verify.typecheck", "typescript compiler not found; typecheck skipped");
      return { passed: true, message: t("verify.typecheck_skipped_no_tsc") };
    }
    try {
      await this.runAsync(`${tsc} --noEmit`, root, 60_000);
      return { passed: true, message: t("verify.typecheck_passed") };
    } catch (e: unknown) {
      const rec = e as { stderr?: unknown; stdout?: unknown } | null | undefined;
      const fallback = e instanceof Error ? e.message : String(e);
      const stderr = String(rec?.stderr ?? "") || String(rec?.stdout ?? "") || fallback;
      return {
        passed: false,
        message: t("verify.typecheck_failed", { error: stderr.slice(0, 500) }),
      };
    }
  }

  /** Типчекает файл от его расположения (вложенный tsconfig), а не от baseDir. */
  async runTypeCheckForFile(filePath: string): Promise<VerificationItem> {
    const projectRoot = findProjectRoot(filePath, this.baseDir, ["tsconfig.json", "package.json"]);
    const tsconfigPath = join(projectRoot, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      this.degrade("verify.typecheck", `no tsconfig.json at ${projectRoot}; typecheck skipped`);
      return { passed: true, message: t("verify.typecheck_skipped_no_tsconfig") };
    }
    const tsc = resolveTscCommand(projectRoot);
    if (!tsc) {
      this.degrade("verify.typecheck", "typescript compiler not found; typecheck skipped");
      return { passed: true, message: t("verify.typecheck_skipped_no_tsc") };
    }
    try {
      await this.runAsync(`${tsc} --noEmit --skipLibCheck`, projectRoot, 60_000);
      return { passed: true, message: t("verify.typecheck_passed") };
    } catch (e: unknown) {
      const rec = e as { stderr?: unknown; stdout?: unknown } | null | undefined;
      const fallback = e instanceof Error ? e.message : String(e);
      const stderr = String(rec?.stderr ?? "") || String(rec?.stdout ?? "") || fallback;
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
      this.degrade("verify.tests", "no package.json; tests skipped");
      return { passed: true, message: t("verify.tests_skipped_no_package") };
    }
    try {
      const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
      if (!pkg.scripts?.test) {
        this.degrade("verify.tests", "no test script in package.json; tests skipped");
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

  /** Критерии: `file-exists:`, `substring-in-file:`, `command-exit-0:`; прочее — warning. */
  async verifyCriteria(owner: { id: string; check?: string }): Promise<CriteriaResult> {
    return evaluateCriteria(owner, {
      baseDir: this.baseDir,
      checkFileExists: (path) => this.checkFileExists(path),
      run: (command, cwd, timeoutMs) => this.runAsync(command, cwd, timeoutMs),
    });
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

  private validateSyntax(filePath: string): Promise<boolean> {
    return checkSyntax(filePath, {
      baseDir: this.baseDir,
      run: (command, cwd, timeoutMs) => this.runAsync(command, cwd, timeoutMs),
      degrade: (operation, reason) => this.degrade(operation, reason),
    });
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
        settleChildClose(
          code,
          stdout,
          stderr,
          `Command failed with exit code ${code}`,
          resolve,
          reject,
        );
      });
    });
  }
}
