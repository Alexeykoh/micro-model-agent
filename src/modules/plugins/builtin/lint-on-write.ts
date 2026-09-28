// Встроенный плагин: синтаксис-проверка записи, проектный lint и дебаунснутый typecheck.
import type { AgentPlugin } from "../../types";
import type { ToolContext, ToolCall, ToolResult } from "../../../tools/types";
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, extname, join } from "path";
import { platform } from "os";
import { findProjectRoot, resolveTscCommand } from "../../lsp/project-root";
import { autoFixErrors, parseTscOutput } from "../../../tools/auto-fixer";
import { LINT_TYPE_CHECK_DEBOUNCE_MS as TYPE_CHECK_DEBOUNCE_MS } from "../../../config/timeouts";
import { settleChildClose } from "../../../utils/child-run";

// Проекты, чей lint-скрипт ссылается на неустановленный бинарник
// (ключ baseDir::script). Сам прогон дорог, а маркер провала — чистый шум,
// поэтому пропускаем до конца процесса.
const missingLintBinaries = new Set<string>();

function lintCacheKey(baseDir: string, lintScript: string): string {
  return `${baseDir}::${lintScript}`;
}

// Шелл-уровень "command not found" по локалям/рантаймам: POSIX `sh` пишет
// "command not found" (exit 127); Windows cmd.exe — "is not recognized"
// (en) / "не является внутренней или внешней командой" (ru), exit 1/9009.
const MISSING_BINARY_RE =
  /command not found|not recognized|не является внутренней|не распознан|не є внутрішньою|".+?" не является/i;

function isMissingBinaryError(err: any, combinedOutput: string): boolean {
  // 127 = POSIX sh "command not found"; 9009 = Windows cmd.exe "is not
  // recognized" — оба авторитетны независимо от кодировки вывода.
  if (err.status === 127 || err.status === 9009) return true;
  if (err.code === "ENOENT") return true;
  return MISSING_BINARY_RE.test(combinedOutput);
}

// Пофайловые синтаксис-проверки кешируются по (путь, хеш содержимого): перезапись
// файла с тем же содержимым скипает (дорогую) проверку. Смена контента →
// промах кеша → свежая проверка.
const syntaxCache = new Map<string, { hash: string; error: string | null }>();

function contentHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return String(h);
}

let _winDecoder: TextDecoder | undefined;

/**
 * OEM-декодер активной консольной кодовой страницы (CP866 на русской Windows).
 * Зеркалит `getOemDecoder()` из modules/processes/registry.ts: транзиентный
 * провал chcp.com под нагрузкой НЕ кешируется — мемоизируется только успешный
 * проб (или жёсткий фолбэк ibm866).
 */
function getWinDecoder(): TextDecoder {
  if (_winDecoder !== undefined) return _winDecoder;
  if (platform() !== "win32") {
    _winDecoder = new TextDecoder("utf-8");
    return _winDecoder;
  }
  let decoder: TextDecoder | null = null;
  try {
    const cpOut = execSync("chcp.com", {
      encoding: "buffer",
      timeout: 2000,
      windowsHide: true,
    }).toString("latin1");
    const m = cpOut.match(/(\d+)/);
    if (m) decoder = new TextDecoder(`ibm${m[1]}`);
  } catch {
    /* chcp упал (нагрузка/ENOENT) — повторим при следующем вызове */
  }
  if (!decoder) {
    try {
      decoder = new TextDecoder("ibm866");
    } catch {
      return new TextDecoder("utf-8"); // неизвестная кодировка — не кешируем
    }
  }
  _winDecoder = decoder;
  return _winDecoder;
}

/**
 * Декодирует вывод дочернего процесса в UTF-8. Современные тулы (bun, node,
 * npm, tsc) пишут UTF-8 в пайп; встроенные команды/ошибки cmd.exe — OEM-страницу.
 * Сначала строгий UTF-8; на невалидных байтах — откат на OEM.
 */
function decodeOutput(chunks: Buffer[]): string {
  const raw = Buffer.concat(chunks);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    /* невалидный UTF-8 → вывод в OEM-кодировке */
  }
  try {
    return getWinDecoder().decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

/** Встроенный плагин: проверяет каждую запись/правку файла (синтаксис, lint, типы). */
export class LintOnWritePlugin implements AgentPlugin {
  name = "lint-on-write";
  priority = 10;
  isBuiltin = true;
  // Дебаунснутый проектный typecheck по корню проекта. Один общий слот
  // протекал tsc-ошибками одного проекта в записи другого (монорепо).
  private _checks = new Map<string, { at: number; promise: Promise<string | null> }>();

  /** После записи/правки: синтаксис файла, затем проектные lint и typecheck. */
  async onAfterTool(ctx: ToolContext, call: ToolCall, result: ToolResult): Promise<void> {
    if (call.name !== "write_file" && call.name !== "edit_file") {
      return;
    }

    if (!result.success) {
      return;
    }

    const path = String(call.arguments.path || "");
    if (!path) return;

    const fullPath = resolve(ctx.baseDir, path);
    if (!existsSync(fullPath)) return;

    const signal = (ctx as { signal?: AbortSignal }).signal;
    if (signal?.aborted) return;

    const ext = extname(fullPath);
    const syntaxError = await this.checkSyntax(fullPath, ext, ctx.baseDir, signal);
    if (signal?.aborted) return;

    if (syntaxError) {
      result.output += `\n\n[Syntax check failed]: ${syntaxError}`;
      return;
    }

    await this.runProjectLint(ctx, result, signal);
    if (signal?.aborted) return;
    await this.runProjectTypeCheck(fullPath, ctx.baseDir, result, signal);
  }

  private async checkSyntax(
    filePath: string,
    ext: string,
    baseDir: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (ext === ".ts" || ext === ".tsx" || ext === ".cts" || ext === ".mts") {
      // Проверка только синтаксиса парсером bun (~200мс) вместо `npx tsc`
      // (~3-5с на запись). Полные ошибки типов всё равно отдаёт дебаунснутый
      // проектный typecheck ниже, когда есть tsconfig.
      let content = "";
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
      const hash = contentHash(content);
      const cached = syntaxCache.get(filePath);
      if (cached && cached.hash === hash) {
        return cached.error;
      }
      try {
        await runAsync(
          { file: "bun", args: ["build", "--no-bundle", "--target=bun", filePath] },
          baseDir,
          10000,
          signal,
        );
        // Прерванная проверка (interrupt) файл не валидировала — не кешируем.
        if (signal?.aborted) return null;
        syntaxCache.set(filePath, { hash, error: null });
        return null;
      } catch (err: any) {
        if (
          err.status === 127 ||
          err.message.includes("not found") ||
          err.message.includes("ENOENT")
        ) {
          return null;
        }
        const stderr = err.stderr?.toString() || err.stdout?.toString() || "";
        const firstError =
          stderr.split("\n").find((line: string) => line.trim()) || "TypeScript syntax error";
        syntaxCache.set(filePath, { hash, error: firstError.trim() });
        return firstError.trim();
      }
    }

    if (ext === ".js" || ext === ".jsx" || ext === ".cjs" || ext === ".mjs") {
      try {
        await runAsync({ file: "node", args: ["--check", filePath] }, baseDir, 5000, signal);
        return null;
      } catch (err: any) {
        const stderr = err.stderr?.toString() || "";
        const firstError =
          stderr.split("\n").find((line: string) => line.trim()) || "JavaScript syntax error";
        return firstError.trim();
      }
    }

    return null;
  }

  private async runProjectLint(
    ctx: ToolContext,
    result: ToolResult,
    signal?: AbortSignal,
  ): Promise<void> {
    let lintScript: string | undefined;
    try {
      const packageJsonPath = join(ctx.baseDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return;
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      lintScript = packageJson.scripts?.lint;

      if (!lintScript) {
        return;
      }

      // Объявленный, но неустановленный бинарник линтера ("eslint" не стоит) —
      // пробел проектного сетапа, а не проблема кода: дописывание его к каждой
      // записи засоряло контекст ~25×/сессию (ses_mt4fn58c). Детектим раз
      // и дальше скипаем молча до конца процесса.
      if (missingLintBinaries.has(lintCacheKey(ctx.baseDir, lintScript))) {
        ctx.logger.debug(`Lint skipped (linter for "${lintScript}" not installed)`);
        return;
      }

      ctx.logger.debug(`Running lint: ${lintScript}`);
      await runAsync(lintScript, ctx.baseDir, 30_000, signal);
      ctx.logger.debug("Lint passed");
    } catch (err: any) {
      const stderr = (err.stderr?.toString?.() || "").trim();
      const stdout = (err.stdout?.toString?.() || "").trim();
      const combined = `${stderr}\n${stdout}`;
      if (lintScript && isMissingBinaryError(err, combined)) {
        missingLintBinaries.add(lintCacheKey(ctx.baseDir, lintScript));
        ctx.logger.debug(`Lint binary missing — skipping project lint for this session`);
        return;
      }
      const detail = combined
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-5)
        .join("\n");
      ctx.logger.warn(`Lint failed: ${err.message}`);
      result.output += `\n\n[Project lint failed]: ${detail}`;
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
    if (!existsSync(tsconfigPath)) {
      return;
    }
    // Без локального tsc проверка невозможна — не платим npx-задержку.
    const tsc = resolveTscCommand(projectRoot);
    if (!tsc) {
      return;
    }

    const now = Date.now();
    const prev = this._checks.get(projectRoot);
    if (prev && now - prev.at < TYPE_CHECK_DEBOUNCE_MS) {
      const error = await prev.promise;
      if (error) {
        result.output += `\n\n[Project typecheck failed]: ${error}`;
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

        if (fixResult.fixed) {
          // Пишем починенное содержимое
          writeFileSync(filePath, fixResult.newContent, "utf-8");
          result.output += `\n\n[Auto-fixed]: ${fixResult.applied.join("; ")}`;

          // Если остались ошибки — показываем их
          if (fixResult.remaining.length > 0) {
            const remainingMsg = fixResult.remaining
              .map((e) => `TS${e.code}: ${e.message}`)
              .join("\n");
            result.output += `\n\n[Remaining errors]: ${remainingMsg}`;
          }
        } else {
          result.output += `\n\n[Project typecheck failed]: ${error}`;
        }
      } else {
        result.output += `\n\n[Project typecheck failed]: ${error}`;
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
    } catch (err: any) {
      if (
        err.status === 127 ||
        err.message.includes("not found") ||
        err.message.includes("ENOENT")
      ) {
        return null;
      }
      const stderr = err.stderr?.toString() || err.stdout?.toString() || "";
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

/**
 * Гоняет команду асинхронно (не стопая event loop) и резолвится на выходе.
 * Реджектит с захваченными stderr/stdout при ненулевом коде или таймауте.
 *
 * Простая строка идёт через шелл (проектные скрипты). Спецификация
 * `{file,args}` спавнится БЕЗ шелла — обязательно для всего, собранного из
 * модельного пути (`bun build … <file>`, `node --check <file>`): в имени могут
 * быть `$()`, бектики или `%VAR%`, а shell:true их исполнил бы (инъекция).
 */
function runAsync(
  command: string | { file: string; args: string[] },
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child =
      typeof command === "string"
        ? spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command.file, command.args, {
            cwd,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    const utf8Chunks: Buffer[] = [];
    const oemChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => {
      utf8Chunks.push(Buffer.from(d));
    });
    child.stderr?.on("data", (d: Buffer) => {
      oemChunks.push(Buffer.from(d));
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Прерывание (Esc/Ctrl+C): убиваем ребёнка, чтобы петля агента сразу
    // вернулась в промпт, а не высиживала длинный tsc/lint. Хендлер close
    // при аборте резолвит пусто — гард `signal.aborted` вызывающего результат
    // всё равно отбрасывает.
    const onAbort = () => child.kill();
    if (signal?.aborted) {
      child.kill();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        resolve({ stdout: decodeOutput(utf8Chunks), stderr: decodeOutput(oemChunks) });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = decodeOutput(utf8Chunks);
      const stderr = decodeOutput(oemChunks);
      if (signal?.aborted) {
        resolve({ stdout, stderr });
        return;
      }
      settleChildClose(code, stdout, stderr, `Command failed with exit code ${code}`, resolve, reject);
    });
  });
}

/** Готовый инстанс для регистрации. */
export const plugin = new LintOnWritePlugin();
