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

export interface VerificationItem {
  passed: boolean;
  message: string;
}

/** Result of checking one subtask's machine-readable success_criteria. */
export interface SubtaskCriteriaResult {
  errors: string[];
  /** LLM-only criteria (not machine-checkable) — surfaced as warnings. */
  warnings: string[];
  details: VerificationItem[];
}

export interface StepVerificationResult {
  passed: boolean;
  syntaxValid: boolean;
  failed: VerificationItem[];
  noFiles?: boolean;
}

export interface MoEVerificationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  details: VerificationItem[];
}

export class StepVerifier {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async checkFileExists(path: string): Promise<VerificationItem> {
    const resolved = resolve(this.baseDir, path);
    const exists = existsSync(resolved);
    return {
      passed: exists,
      message: exists ? t("verify.file_exists", { path }) : t("verify.file_not_found", { path }),
    };
  }

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

  async runTypeCheck(): Promise<VerificationItem> {
    const tsconfigPath = resolve(this.baseDir, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      return { passed: true, message: "No tsconfig.json found — skipping type check" };
    }
    const tsc = resolveTscCommand(this.baseDir);
    if (!tsc) return { passed: true, message: "tsc not installed — skipping type check" };
    try {
      await this.runAsync(`${tsc} --noEmit`, this.baseDir, 60_000);
      return { passed: true, message: "TypeScript type check passed" };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message;
      return { passed: false, message: `TypeScript type check failed: ${stderr.slice(0, 500)}` };
    }
  }

  /**
   * Type-check a specific file, resolving the project root from the FILE's
   * location (not the agent baseDir). For nested layouts (`baseDir/proj/` with
   * its own tsconfig.json) the old baseDir-based check silently skipped every
   * type error (observed in ses_mst2r0r5: zero type feedback for the whole
   * session). Markers mirror the TypeScript LSP server config.
   */
  async runTypeCheckForFile(filePath: string): Promise<VerificationItem> {
    const projectRoot = findProjectRoot(filePath, this.baseDir, ["tsconfig.json", "package.json"]);
    const tsconfigPath = join(projectRoot, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
      return { passed: true, message: "No tsconfig.json found — skipping type check" };
    }
    const tsc = resolveTscCommand(projectRoot);
    if (!tsc) return { passed: true, message: "tsc not installed — skipping type check" };
    try {
      await this.runAsync(`${tsc} --noEmit --skipLibCheck`, projectRoot, 60_000);
      return { passed: true, message: "TypeScript type check passed" };
    } catch (e: any) {
      const stderr = e.stderr?.toString() || e.stdout?.toString() || e.message;
      return { passed: false, message: `TypeScript type check failed: ${stderr.slice(0, 500)}` };
    }
  }

  async runTests(): Promise<VerificationItem> {
    const pkgPath = resolve(this.baseDir, "package.json");
    if (!existsSync(pkgPath)) {
      return { passed: true, message: "No package.json found — skipping tests" };
    }
    try {
      const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
      if (!pkg.scripts?.test) {
        return { passed: true, message: "No test script defined — skipping tests" };
      }
    } catch {
      /* fall through — attempt to run */
    }
    return this.runScript("test");
  }

  async verifyArtifactFiles(files: string[]): Promise<VerificationItem[]> {
    return Promise.all(files.map((f) => this.checkFileExists(f)));
  }

  /**
   * Check a subtask's machine-readable success_criteria BEFORE the merge
   * decision (Plan 5.1). Supported forms:
   * - `file-exists:<path>`
   * - `substring-in-file:<path>:<text>`
   * - `command-exit-0:<command>`
   * Anything else is treated as an LLM-only criterion and reported as a
   * warning (never an error) so the Router still sees it in context.
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

    const tscResult = await this.runTypeCheck();
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

      // Machine-readable success_criteria (Plan 5.1) — checked before merge.
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

  async verifyStep(stepDescription: string, kind?: StepKind): Promise<StepVerificationResult> {
    const fileMatches = extractFileLikeTokens(stripUrls(stepDescription));

    // No named files — this step cannot be verified by file existence. Do NOT
    // trivially pass (empty every() = true); signal noFiles so the tool guides
    // the model to run a real check instead.
    if (fileMatches.length === 0) {
      return { passed: false, syntaxValid: true, failed: [], noFiles: true };
    }

    const results: VerificationItem[] = [];
    let syntaxValid = true;

    for (const filePath of fileMatches) {
      const resolved = findExistingFile(this.baseDir, filePath);
      const exists = !!resolved;

      if (kind === "delete") {
        // For delete steps: file NOT existing is a pass
        results.push({
          passed: !exists,
          message: exists
            ? t("verify.file_still_exists", { path: filePath })
            : t("verify.file_not_found", { path: filePath }),
        });
        // Don't syntax-check a deleted file
        continue;
      }

      // Create steps: file must exist + valid syntax
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
        // Quote the path — commands run through a shell and break on spaces.
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
   * Run a command asynchronously (non-blocking event loop) and resolve when it
   * exits. Rejects with the captured stderr/stdout on non-zero exit or timeout.
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
        child.kill();
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
