import { existsSync } from "fs";
import { resolve, extname, dirname, join } from "path";
import { spawn } from "child_process";
import { t } from "../../i18n/index";
import type { MoEPlan } from "./types";
import type { AppConfig } from "../../config/types";
import { validateExpertConfig } from "../../config/experts";
import { findProjectRoot } from "../lsp/project-root";

export interface VerificationItem {
  passed: boolean;
  message: string;
}

export interface StepVerificationResult {
  passed: boolean;
  syntaxValid: boolean;
  failed: VerificationItem[];
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
    try {
      await this.runAsync("npx tsc --noEmit", this.baseDir, 60_000);
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
    try {
      await this.runAsync("npx tsc --noEmit --skipLibCheck", projectRoot, 60_000);
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
    }

    return {
      success: errors.length === 0,
      errors,
      warnings,
      details,
    };
  }

  async verifyStep(stepDescription: string): Promise<StepVerificationResult> {
    const fileMatches = stepDescription.match(/\b[\w./-]+\.[a-z]+/gi) || [];
    const results: VerificationItem[] = [];
    let syntaxValid = true;

    for (const filePath of fileMatches) {
      const result = await this.checkFileExists(filePath);
      results.push(result);

      if (result.passed) {
        const fullPath = resolve(this.baseDir, filePath);
        if (!(await this.validateSyntax(fullPath))) {
          syntaxValid = false;
          results.push({ passed: false, message: t("verify.syntax_error", { path: filePath }) });
        }
      }
    }

    return {
      passed: results.every((r) => r.passed),
      syntaxValid,
      failed: results.filter((r) => !r.passed),
    };
  }

  private async validateSyntax(filePath: string): Promise<boolean> {
    const ext = extname(filePath);

    if (ext === ".ts" || ext === ".tsx" || ext === ".cts" || ext === ".mts") {
      try {
        await this.runAsync(`npx tsc --noEmit --skipLibCheck ${filePath}`, this.baseDir, 10000);
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
        await this.runAsync(`node --check ${filePath}`, this.baseDir, 5000);
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
