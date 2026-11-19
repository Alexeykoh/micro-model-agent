// Встроенный плагин: синтаксис-проверка записи, проектный lint и дебаунснутый typecheck.
import type { AgentPlugin, PluginHookContext } from "../../types";
import type { ToolContext, ToolCall, ToolResult } from "../../../tools/types";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, extname, join } from "path";
import { findProjectRoot, resolveTscCommand } from "../../lsp/project-root";
import { autoFixErrors, parseTscOutput } from "../../../tools/auto-fixer";
import { LINT_TYPE_CHECK_DEBOUNCE_MS as TYPE_CHECK_DEBOUNCE_MS } from "../../../config/timeouts";
import {
  childErr,
  isLintBinaryMissing,
  isMissingBinaryError,
  markLintBinaryMissing,
  runAsync,
} from "./lint-run";
import { checkSyntax } from "./lint-syntax";
import {
  autoFixedBlock,
  lintFailureBlock,
  remainingErrorsBlock,
  syntaxFailureBlock,
  typecheckFailureBlock,
} from "./lint-format";
import { LINT_ON_WRITE_SCHEMA, lintOnWriteSettings } from "./plugin-settings";

/** Встроенный плагин: проверяет каждую запись/правку файла (синтаксис, lint, типы). */
export class LintOnWritePlugin implements AgentPlugin {
  name = "lint-on-write";
  priority = 10;
  isBuiltin = true;
  settingsSchema = LINT_ON_WRITE_SCHEMA;
  // Дебаунснутый проектный typecheck по корню проекта. Один общий слот
  // протекал tsc-ошибками одного проекта в записи другого (монорепо).
  private _checks = new Map<string, { at: number; promise: Promise<string | null> }>();

  /** После записи/правки: синтаксис файла, затем проектные lint и typecheck. */
  async onAfterTool(ctx: PluginHookContext, call: ToolCall, result: ToolResult): Promise<void> {
    const tctx = ctx as unknown as ToolContext;
    if (call.name !== "write_file" && call.name !== "edit_file") {
      return;
    }

    if (!result.success) return;

    const settings = lintOnWriteSettings();
    if (!settings.syntaxCheck && !settings.projectLint && !settings.typeCheck) return;

    const path = String(call.arguments.path || "");
    if (!path) return;

    const fullPath = resolve(tctx.baseDir, path);
    if (!existsSync(fullPath)) return;

    const signal = (ctx as { signal?: AbortSignal }).signal;
    if (signal?.aborted) return;

    const ext = extname(fullPath);
    const syntaxError = settings.syntaxCheck
      ? await checkSyntax(fullPath, ext, tctx.baseDir, signal)
      : null;
    if (signal?.aborted) return;

    if (syntaxError) {
      result.output += syntaxFailureBlock(syntaxError);
      return;
    }

    if (settings.projectLint) await this.runProjectLint(tctx, result, signal);
    if (signal?.aborted) return;
    if (settings.typeCheck) await this.runProjectTypeCheck(fullPath, tctx.baseDir, result, signal);
  }

  private async runProjectLint(
    ctx: ToolContext,
    result: ToolResult,
    signal?: AbortSignal,
  ): Promise<void> {
    let lintScript: string | undefined;
    try {
      const packageJsonPath = join(ctx.baseDir, "package.json");
      if (!existsSync(packageJsonPath)) return;

      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      lintScript = packageJson.scripts?.lint;

      if (!lintScript) return;

      // Объявленный, но неустановленный бинарник линтера ("eslint" не стоит) —
      // пробел проектного сетапа, а не проблема кода: дописывание его к каждой
      // записи засоряло контекст ~25×/сессию (ses_mt4fn58c). Детектим раз
      // и дальше скипаем молча до конца процесса.
      if (isLintBinaryMissing(ctx.baseDir, lintScript)) {
        ctx.logger.debug(`Lint skipped (linter for "${lintScript}" not installed)`);
        return;
      }

      ctx.logger.debug(`Running lint: ${lintScript}`);
      await runAsync(lintScript, ctx.baseDir, 30_000, signal);
      ctx.logger.debug("Lint passed");
    } catch (rawErr: unknown) {
      const err = childErr(rawErr);
      const stderr = String(err.stderr ?? "").trim();
      const stdout = String(err.stdout ?? "").trim();
      const combined = `${stderr}\n${stdout}`;
      if (lintScript && isMissingBinaryError(err, combined)) {
        markLintBinaryMissing(ctx.baseDir, lintScript);
        ctx.logger.debug(`Lint binary missing — skipping project lint for this session`);
        return;
      }
      ctx.logger.warn(`Lint failed: ${err.message}`);
      result.output += lintFailureBlock(combined);
    }
  }

  private async runProjectTypeCheck(
    filePath: string,
    baseDir: string,
    result: ToolResult,
    signal?: AbortSignal,
  ): Promise<void> {
    // Корень проекта резолвим от РЕДАКТИРОВАННОГО ФАЙЛА, а не от baseDir агента.
    // Во вложенной раскладке (`baseDir/proj/tsconfig.json`) старый поиск от
    // baseDir молча скипал typecheck на каждой записи — вся сессия шла
    // вообще без типового фидбэка (наблюдено в ses_mst2r0r5).
    const projectRoot = findProjectRoot(filePath, baseDir, ["tsconfig.json", "package.json"]);
    const tsconfigPath = join(projectRoot, "tsconfig.json");
    if (!existsSync(tsconfigPath)) return;
    // Без локального tsc проверка невозможна — не платим npx-задержку.
    const tsc = resolveTscCommand(projectRoot);
    if (!tsc) return;

    const now = Date.now();
    const prev = this._checks.get(projectRoot);
    if (prev && now - prev.at < TYPE_CHECK_DEBOUNCE_MS) {
      const error = await prev.promise;
      if (error) {
        result.output += typecheckFailureBlock(error);
      }
      return;
    }

    const promise = this.runTscCheck(tsc, projectRoot, signal);
    this._checks.set(projectRoot, { at: now, promise });
    const error = await promise;
    if (error) {
      // Пробуем автофиксить чинимые ошибки
      const { stdout, stderr } = await runAsync(
        `${tsc} --noEmit --skipLibCheck 2>&1`,
        projectRoot,
        30000,
        signal,
      ).catch(() => ({ stdout: "", stderr: error }));

      const output = stderr || stdout;
      const errors = parseTscOutput(output);

      if (errors.length > 0) {
        const fixResult = autoFixErrors(filePath, readFileSync(filePath, "utf-8"), errors);

        if (fixResult.fixed && lintOnWriteSettings().autoFix) {
          // Пишем починенное содержимое
          writeFileSync(filePath, fixResult.newContent, "utf-8");
          result.output += autoFixedBlock(fixResult.applied);

          // Если остались ошибки — показываем их
          if (fixResult.remaining.length > 0) {
            result.output += remainingErrorsBlock(fixResult.remaining);
          }
        } else {
          result.output += typecheckFailureBlock(error);
        }
      } else {
        result.output += typecheckFailureBlock(error);
      }
    }
  }

  private async runTscCheck(
    tsc: string,
    baseDir: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    try {
      await runAsync(`${tsc} --noEmit --skipLibCheck`, baseDir, 30000, signal);
      return null;
    } catch (rawErr: unknown) {
      const err = childErr(rawErr);
      if (
        err.status === 127 ||
        err.message.includes("not found") ||
        err.message.includes("ENOENT")
      ) {
        return null;
      }
      const stderr = String(err.stderr ?? "") || String(err.stdout ?? "");
      if (stderr.includes("error TS")) {
        const firstError =
          stderr.split("\n").find((line: string) => line.includes("error TS")) ||
          "TypeScript type error";
        return firstError.trim();
      }
      return null;
    }
  }
}

/** Готовый инстанс для регистрации. */
export const plugin = new LintOnWritePlugin();
