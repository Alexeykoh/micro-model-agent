import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { FileLogWriter, type FileLogLevel } from "./file-log";
import pc from "picocolors";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: (s) => pc.dim(s),
  info: (s) => s,
  warn: (s) => pc.yellow(s),
  error: (s) => pc.red(s),
};

function isColorEnabled(): boolean {
  return (
    !process.env.NO_COLOR && !process.env.CI && process.stdout.isTTY === true
  );
}

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private logDir: string | null = null;
  private sessionDir: string | null = null;
  private fileLog: FileLogWriter;

  constructor(level: LogLevel = "info", prefix = "") {
    this.level = level;
    this.prefix = prefix;
    this.fileLog = new FileLogWriter();
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setLogDir(dir: string): void {
    this.logDir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.fileLog.setLogDir(dir);
  }

  setSessionDir(dir: string): void {
    this.sessionDir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  clearSessionDir(): void {
    this.sessionDir = null;
  }

  /** Open a per-session `.log` file (legacy v1 behavior). */
  initSessionLog(sessionId: string): void {
    this.fileLog.initSessionLog(sessionId);
  }

  /** Fall back to daily log files when no session is active. */
  closeSessionLog(): void {
    this.fileLog.closeSessionLog();
  }

  getLogPath(): string {
    return this.fileLog.getLogPath();
  }

  cleanupOldLogs(maxDays?: number, maxFiles?: number): void {
    this.fileLog.cleanupOldLogs(maxDays, maxFiles);
  }

  // --- Tagged helpers (legacy v1 API) ---

  logLLMRequest(
    model: string,
    messagesCount: number,
    promptPreview: string,
    caller?: string,
  ): void {
    this.fileLog.logLLMRequest(model, messagesCount, promptPreview, caller);
  }

  logLLMResponse(
    model: string,
    responseLength: number,
    genTimeMs: number,
    error?: string,
    caller?: string,
  ): void {
    this.fileLog.logLLMResponse(
      model,
      responseLength,
      genTimeMs,
      error,
      caller,
    );
  }

  logToolCall(tool: string, preview: string, result?: string): void {
    this.fileLog.logToolCall(tool, preview, result);
  }

  logToolOutput(tool: string, output: string, exitCode: number): void {
    this.fileLog.logToolOutput(tool, output, exitCode);
  }

  logREPL(tag: "user" | "assistant" | "system", content: string): void {
    this.fileLog.logREPL(tag, content);
  }

  child(prefix: string): Logger {
    const childLogger = new Logger(
      this.level,
      this.prefix ? `${this.prefix}:${prefix}` : prefix,
    );
    if (this.logDir) childLogger.setLogDir(this.logDir);
    if (this.sessionDir) childLogger.setSessionDir(this.sessionDir);
    return childLogger;
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log("debug", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.log("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log("warn", msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.log("error", msg, meta);
  }

  private log(
    level: LogLevel,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVELS[level] < LEVELS[this.level]) return;

    // Sanitize log message to remove sensitive data
    const sanitizedMsg = sanitizeLogMessage(msg);
    const sanitizedMeta = meta ? this.sanitizeMeta(meta) : undefined;

    const ts = new Date().toISOString();
    const prefix = this.prefix ? ` [${this.prefix}]` : "";
    const metaStr = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : "";

    const line = `[${level.toUpperCase()}]${prefix} ${ts} — ${sanitizedMsg}${metaStr}`;
    console.log(isColorEnabled() ? LEVEL_COLORS[level](line) : line);

    // Legacy v1 behavior: also append to the tagged `.log` file (session or daily).
    this.fileLog.log(
      level.toUpperCase() as FileLogLevel,
      this.prefix || "MMA",
      `${ts} — ${sanitizedMsg}${metaStr}`,
    );

    const logTarget = this.sessionDir ?? this.logDir;
    if (logTarget) {
      try {
        appendFileSync(
          join(logTarget, "app.jsonl"),
          JSON.stringify({
            level,
            ts,
            prefix: this.prefix,
            msg: sanitizedMsg,
            meta: sanitizedMeta ?? null,
          }) + "\n",
          "utf-8",
        );
      } catch {
        /* file logging is best-effort */
      }
    }
  }

  /**
   * Sanitize metadata object to remove sensitive data
   */
  private sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
      if (typeof value === "string") {
        sanitized[key] = sanitizeLogMessage(value);
      } else if (typeof value === "object" && value !== null) {
        sanitized[key] = this.sanitizeMeta(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
