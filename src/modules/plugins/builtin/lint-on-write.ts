import type { AgentPlugin } from "../../types";
import type { ToolContext, ToolCall, ToolResult } from "../../../tools/types";
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve, extname, join } from "path";
import { platform } from "os";
import { findProjectRoot, resolveTscCommand } from "../../lsp/project-root";
import { autoFixErrors, parseTscOutput } from "../../../tools/auto-fixer";

const TYPE_CHECK_DEBOUNCE_MS = 2000;

// Projects whose lint script points at a binary that is not installed
// (keyed by baseDir::script). The run itself is expensive and the failure
// marker is pure noise — skip for the rest of the process.
const missingLintBinaries = new Set<string>();

function lintCacheKey(baseDir: string, lintScript: string): string {
  return `${baseDir}::${lintScript}`;
}

// Shell-level "command not found" across locales/runtimes: POSIX `sh` prints
// "command not found" (exit 127); Windows cmd.exe prints "is not recognized"
// (en) / "не является внутренней или внешней командой" (ru) with exit 1/9009.
const MISSING_BINARY_RE =
  /command not found|not recognized|не является внутренней|не распознан|не є внутрішньою|".+?" не является/i;

function isMissingBinaryError(err: any, combinedOutput: string): boolean {
  // 127 = POSIX sh "command not found"; 9009 = Windows cmd.exe "is not
  // recognized" — both are authoritative regardless of output encoding.
  if (err.status === 127 || err.status === 9009) return true;
  if (err.code === "ENOENT") return true;
  return MISSING_BINARY_RE.test(combinedOutput);
}

// Per-file syntax checks are cached by (path, content hash): re-writing a file
// with identical content skips the (expensive) check. Content changes → cache
// miss → fresh check.
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
 * OEM decoder for the active console code page (CP866 on Russian Windows).
 * Mirrors `getOemDecoder()` in modules/processes/registry.ts: a transient
 * chcp.com failure under load must NOT be cached — only a successful probe
 * (or the hard ibm866 fallback) is memoized.
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
    if (m) decoder = new TextDecoder("ibm" + m[1]);
  } catch {
    /* chcp failed (load/ENOENT) — retry on the next call */
  }
  if (!decoder) {
    try {
      decoder = new TextDecoder("ibm866");
    } catch {
      return new TextDecoder("utf-8"); // unknown encoding — do not cache
    }
  }
  _winDecoder = decoder;
  return _winDecoder;
}

/**
 * Decode child-process output to UTF-8. Modern tools (bun, node, npm, tsc)
 * write UTF-8 into the pipe; cmd.exe builtins/errors use the OEM code page.
 * Strict UTF-8 first; on invalid byte sequences fall back to OEM.
 */
function decodeOutput(chunks: Buffer[]): string {
  const raw = Buffer.concat(chunks);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    /* not valid UTF-8 → OEM code page output */
  }
  try {
    return getWinDecoder().decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

export class LintOnWritePlugin implements AgentPlugin {
  name = "lint-on-write";
  priority = 10;
  isBuiltin = true;
  private _checkPromise: Promise<string | null> | null = null;
  private _checkTimestamp = 0;

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
      // Syntax-only check via bun's parser (~200ms) instead of `npx tsc`
      // (~3-5s per write). Full type errors are still surfaced by the
      // debounced project typecheck below when a tsconfig exists.
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
        await runAsync(`bun build --no-bundle --target=bun "${filePath}"`, baseDir, 10000, signal);
        // Aborted check (interrupt) never validated the file — don't cache it.
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
        await runAsync(`node --check "${filePath}"`, baseDir, 5000, signal);
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

      // A declared-but-missing linter binary ("eslint" not installed) is a
      // project-setup gap, not a code problem — appending it to every write
      // result polluted the context ~25×/session (ses_mt4fn58c). Detect it
      // once and skip silently for the rest of the process.
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
    // Resolve the project root from the EDITED FILE, not the agent baseDir.
    // In a nested layout (`baseDir/proj/tsconfig.json`) the old baseDir-based
    // lookup silently skipped the typecheck on every write — the whole
    // session then ran with zero type feedback (observed in ses_mst2r0r5).
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
    if (this._checkPromise && now - this._checkTimestamp < TYPE_CHECK_DEBOUNCE_MS) {
      const error = await this._checkPromise;
      if (error) {
        result.output += `\n\n[Project typecheck failed]: ${error}`;
      }
      return;
    }

    this._checkTimestamp = now;
    this._checkPromise = this.runTscCheck(tsc, projectRoot, signal);
    const error = await this._checkPromise;
    if (error) {
      // Try to auto-fix fixable errors
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
          // Write the fixed content
          writeFileSync(filePath, fixResult.newContent, "utf-8");
          result.output += `\n\n[Auto-fixed]: ${fixResult.applied.join("; ")}`;

          // If there are remaining errors, show them
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
      const { stdout, stderr } = await runAsync(
        `${tsc} --noEmit --skipLibCheck`,
        baseDir,
        30000,
        signal,
      );
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
 * Run a command asynchronously (non-blocking event loop) and resolve when it
 * exits. Rejects with captured stderr/stdout on non-zero exit or timeout.
 */
function runAsync(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
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
    // Interrupt (Esc/Ctrl+C): kill the child so the agent loop can return to
    // the prompt immediately instead of waiting out a long tsc/lint run. The
    // close handler resolves empty when aborted — the caller's `signal.aborted`
    // guard discards the result anyway.
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
      if (signal?.aborted || code === 0) {
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

export const plugin = new LintOnWritePlugin();
