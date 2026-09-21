import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { FileLogWriter, type FileLogLevel } from "./file-log";
import { defaultOutputBus, type OutputSink } from "../output";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

export class Logger {
  private level: LogLevel;
  private prefix: string;
  private logDir: string | null = null;
  private sessionDir: string | null = null;
  private fileLog: FileLogWriter;
  private sink: OutputSink;

  constructor(level: LogLevel = "info", prefix = "", sink: OutputSink = defaultOutputBus) {
    this.level = level;
    this.prefix = prefix;
    this.sink = sink;
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
    this.fileLog.logLLMRequest(model, messagesCount, sanitizeLogMessage(promptPreview), caller);
  }

  logLLMResponse(
    model: string,
    responseLength: number,
    genTimeMs: number,
    error?: string,
    caller?: string,
  ): void {
    this.fileLog.logLLMResponse(model, responseLength, genTimeMs, error, caller);
  }

  logToolCall(tool: string, preview: string, result?: string): void {
    this.fileLog.logToolCall(
      tool,
      sanitizeLogMessage(preview),
      result !== undefined ? sanitizeLogMessage(result) : undefined,
    );
  }

  logToolOutput(tool: string, output: string, exitCode: number): void {
    this.fileLog.logToolOutput(tool, sanitizeLogMessage(output), exitCode);
  }

  logREPL(tag: "user" | "assistant" | "system", content: string): void {
    this.fileLog.logREPL(tag, sanitizeLogMessage(content));
  }

  child(prefix: string): Logger {
    const childLogger = new Logger(
      this.level,
      this.prefix ? `${this.prefix}:${prefix}` : prefix,
      this.sink,
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

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;

    // Sanitize log message to remove sensitive data
    const sanitizedMsg = sanitizeLogMessage(msg);
    const sanitizedMeta = meta ? this.sanitizeMeta(meta) : undefined;

    const ts = new Date().toISOString();
    const metaStr = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : "";

    const line = `${sanitizedMsg}${metaStr}`;
    try {
      this.sink.emit({ level, source: this.prefix || "mma", kind: "log", text: line });
    } catch {
      /* terminal output is best-effort; file logging below must still run */
    }

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

  /**
   * Write a structured record to app.jsonl only (no console / .log output).
   * Used for machine-readable reports (environment, etc.) that would be too
   * noisy on the terminal but are valuable for cross-device diagnosis.
   */
  logStructured(type: string, data: Record<string, unknown>): void {
    const logTarget = this.sessionDir ?? this.logDir;
    if (!logTarget) return;
    try {
      appendFileSync(
        join(logTarget, "app.jsonl"),
        JSON.stringify({
          level: "info",
          ts: new Date().toISOString(),
          type,
          meta: this.sanitizeMeta(data),
        }) + "\n",
        "utf-8",
      );
    } catch {
      /* file logging is best-effort */
    }
  }

  /**
   * Write a log entry to app.jsonl only — no console output, no .log file.
   * Use this for noisy subsystems (LSP, probes) whose warnings should be
   * diagnosable from session files but not pollute the user's terminal.
   */
  logSilent(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    const logTarget = this.sessionDir ?? this.logDir;
    if (!logTarget) return;
    const ts = new Date().toISOString();
    const sanitizedMsg = sanitizeLogMessage(msg);
    const sanitizedMeta = meta ? this.sanitizeMeta(meta) : undefined;
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
