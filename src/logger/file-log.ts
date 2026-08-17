import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const MAX_LOG_SIZE = 5 * 1024 * 1024;
const MAX_LOG_FILES = 30;
const DEFAULT_MAX_DAYS = 30;
const TOOL_OUTPUT_LIMIT = 2000;

export type FileLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/**
 * Tagged file logger (legacy MMA v1 behavior).
 *
 * Writes human-readable log lines to `~/.mma/logs/`:
 * - `<sessionId>.log` while a session is active
 * - `YYYY-MM-DD.log` for everything outside a session
 *
 * Features restored from v1:
 * - size-based rotation (5 MB → file.log.1, file.log.2, ...)
 * - cleanup of old logs (age + max file count)
 * - tagged helpers: LLM request/response, tool calls, REPL
 */
export class FileLogWriter {
  private logDir: string | null = null;
  private sessionLogPath: string | null = null;

  setLogDir(dir: string): void {
    this.logDir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Open a per-session log file. Triggers cleanup of old logs. */
  initSessionLog(sessionId: string): void {
    if (!this.logDir) return;
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
    this.sessionLogPath = join(this.logDir, `${sessionId}.log`);
    this.cleanupOldLogs();
  }

  /** Fall back to daily log files when no session is active. */
  closeSessionLog(): void {
    this.sessionLogPath = null;
  }

  getLogPath(): string {
    if (this.sessionLogPath) return this.sessionLogPath;
    if (!this.logDir) return "";
    const date = new Date().toISOString().slice(0, 10);
    return join(this.logDir, `${date}.log`);
  }

  /** Rotate the file if it exceeds the size limit. */
  private rotateIfNeeded(filePath: string): void {
    if (!existsSync(filePath)) return;
    const size = statSync(filePath).size;
    if (size < MAX_LOG_SIZE) return;

    let idx = 1;
    while (existsSync(`${filePath}.${idx}`)) idx++;
    renameSync(filePath, `${filePath}.${idx}`);
  }

  log(level: FileLogLevel, tag: string, message: string): void {
    const fp = this.getLogPath();
    if (!fp) return;
    if (this.logDir && !existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    this.rotateIfNeeded(fp);
    const line = `[${new Date().toISOString()}] [${level}] [${tag}] ${message}\n`;
    try {
      appendFileSync(fp, line, "utf-8");
    } catch {
      /* file logging is best-effort */
    }
  }

  logLLMRequest(
    model: string,
    messagesCount: number,
    promptPreview: string,
    caller?: string,
  ): void {
    const tag = caller ? `LLM/${caller}` : "LLM";
    this.log(
      "INFO",
      tag,
      `→ ${model} | ${messagesCount} messages | "${promptPreview.slice(0, 100)}"`,
    );
  }

  logLLMResponse(
    model: string,
    responseLength: number,
    genTimeMs: number,
    error?: string,
    caller?: string,
  ): void {
    const tag = caller ? `LLM/${caller}` : "LLM";
    if (error) {
      this.log(
        "ERROR",
        tag,
        `← ${model} | ${responseLength} chars | ${genTimeMs}ms | ERROR: ${error}`,
      );
    } else {
      this.log("INFO", tag, `← ${model} | ${responseLength} chars | ${genTimeMs}ms`);
    }
  }

  logToolCall(tool: string, preview: string, result?: string): void {
    const previewTrimmed = preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
    if (result !== undefined) {
      const resultTrimmed = result.length > 200 ? result.slice(0, 200) + "..." : result;
      this.log("INFO", "TOOL", `${tool} | ${previewTrimmed} → ${resultTrimmed}`);
    } else {
      this.log("INFO", "TOOL", `${tool} | ${previewTrimmed}`);
    }
  }

  logToolOutput(tool: string, output: string, exitCode: number): void {
    const trimmed =
      output.length > TOOL_OUTPUT_LIMIT
        ? output.slice(0, TOOL_OUTPUT_LIMIT) +
          `\n... (truncated ${output.length - TOOL_OUTPUT_LIMIT} chars)`
        : output;
    this.log("DEBUG", "TOOL_OUTPUT", `${tool} exit:${exitCode}\n${trimmed}`);
  }

  logREPL(tag: "user" | "assistant" | "system", content: string): void {
    const trimmed = content.length > 400 ? content.slice(0, 400) + "..." : content;
    this.log("INFO", `REPL/${tag}`, trimmed);
  }

  /**
   * Clean up old log files.
   * - Deletes files older than maxDays
   * - Keeps at most maxFiles most recent .log files
   */
  cleanupOldLogs(maxDays = DEFAULT_MAX_DAYS, maxFiles = MAX_LOG_FILES): void {
    if (!this.logDir || !existsSync(this.logDir)) return;
    const now = Date.now();

    const list = (): Array<{ name: string; path: string; mtime: number }> =>
      readdirSync(this.logDir!)
        .filter((f) => f.endsWith(".log") || /\.log\.\d+$/.test(f))
        .map((f) => ({
          name: f,
          path: join(this.logDir!, f),
          mtime: statSync(join(this.logDir!, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

    // 1. Delete by age.
    for (const f of list()) {
      if (now - f.mtime > maxDays * 24 * 60 * 60 * 1000) {
        try {
          unlinkSync(f.path);
        } catch {
          /* ignore */
        }
      }
    }

    // 2. Delete excess (fresh but more than maxFiles).
    const remaining = list();
    for (let i = maxFiles; i < remaining.length; i++) {
      try {
        unlinkSync(remaining[i].path);
      } catch {
        /* ignore */
      }
    }
  }
}
