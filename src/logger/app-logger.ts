// Логер: шина вывода + файловые логи (.log, app.jsonl), чистка секретов.
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { sanitizeLogMessage } from "../modules/security/data-sanitizer";
import { FileLogWriter, type FileLogLevel } from "./file-log";
import { defaultOutputBus, type OutputSink, moduleSource } from "../output";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
/** Уровень логирования (чем правее, тем строже фильтр). */
export type LogLevel = keyof typeof LEVELS;

/** Центральный логер: консоль через шину, файлы, JSONL, тегированные хелперы. */
export class Logger {
  private level: LogLevel;
  private prefix: string;
  private logDir: string | null = null;
  private sessionDir: string | null = null;
  private sessionId: string | null = null;
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

  /** Открывает посессионный `.log`-файл (поведение legacy v1). */
  initSessionLog(sessionId: string): void {
    this.fileLog.initSessionLog(sessionId);
  }

  /** Возврат к дневным лог-файлам, когда нет активной сессии. */
  closeSessionLog(): void {
    this.fileLog.closeSessionLog();
  }

  /** Путь к текущему лог-файлу (сессионный или дневной). */
  getLogPath(): string {
    return this.fileLog.getLogPath();
  }

  /** Удаляет старые логи по возрасту/количеству. */
  cleanupOldLogs(maxDays?: number, maxFiles?: number): void {
    this.fileLog.cleanupOldLogs(maxDays, maxFiles);
  }

  // Тегированные хелперы (API legacy v1).

  /** Пишет запрос к LLM в файловый лог. */
  logLLMRequest(
    model: string,
    messagesCount: number,
    promptPreview: string,
    caller?: string,
  ): void {
    this.fileLog.logLLMRequest(model, messagesCount, sanitizeLogMessage(promptPreview), caller);
  }

  /** Пишет ответ LLM (или ошибку) в файловый лог. */
  logLLMResponse(
    model: string,
    responseLength: number,
    genTimeMs: number,
    error?: string,
    caller?: string,
  ): void {
    this.fileLog.logLLMResponse(model, responseLength, genTimeMs, error, caller);
  }

  /** Пишет вызов тула и превью результата в файловый лог. */
  logToolCall(tool: string, preview: string, result?: string): void {
    this.fileLog.logToolCall(
      tool,
      sanitizeLogMessage(preview),
      result !== undefined ? sanitizeLogMessage(result) : undefined,
    );
  }

  /** Пишет вывод тула с кодом выхода в файловый лог. */
  logToolOutput(tool: string, output: string, exitCode: number): void {
    this.fileLog.logToolOutput(tool, sanitizeLogMessage(output), exitCode);
  }

  /** Пишет реплику REPL (user/assistant/system) в файловый лог. */
  logREPL(tag: "user" | "assistant" | "system", content: string): void {
    this.fileLog.logREPL(tag, sanitizeLogMessage(content));
  }

  /**
   * Дочерний логер с расширенным префиксом; наследует уровень, sink и каталоги.
   * @param prefix суффикс префикса. @returns новый Logger.
   */
  child(prefix: string): Logger {
    const childLogger = new Logger(
      this.level,
      this.prefix ? `${this.prefix}:${prefix}` : prefix,
      this.sink,
    );
    if (this.logDir) childLogger.setLogDir(this.logDir);
    if (this.sessionDir) childLogger.setSessionDir(this.sessionDir);
    childLogger.sessionId = this.sessionId;
    return childLogger;
  }

  /**
   * Независимый логер одной сессии: свой `FileLogWriter` (посессионный `.log`)
   * и свой `sessionDir` (app.jsonl). Нужен параллельным раннерам: если делить
   * один `Logger`, `initSessionLog`/`setSessionDir` последнего стартовавшего
   * хода перевешивают путь и чужие строки уезжают в лог соседней сессии.
   * Делит уровень, префикс, шину вывода и общий каталог логов.
   * @param sessionId id сессии (имя посессионного `.log`); @param sessionDir каталог сессии для app.jsonl.
   * @returns независимый Logger.
   */
  forSession(sessionId: string, sessionDir?: string): Logger {
    const scoped = new Logger(this.level, this.prefix, this.sink);
    if (this.logDir) scoped.setLogDir(this.logDir);
    if (sessionDir) scoped.setSessionDir(sessionDir);
    scoped.initSessionLog(sessionId);
    scoped.sessionId = sessionId;
    return scoped;
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

  /**
   * Внутренняя диагностика петли (ретраи галлюцинаций, аудит/компакция,
   * вердикты критика, …). Персистентность та же, что у warn/info, но событие
   * шины несёт `data.diagnostic = true`, и чат дропает его, пока
   * `ui.verbosity !== "verbose"`.
   */
  diagnostic(level: Exclude<LogLevel, "debug">, msg: string, meta?: Record<string, unknown>): void {
    this.log(level, msg, meta, true);
  }

  private log(
    level: LogLevel,
    msg: string,
    meta?: Record<string, unknown>,
    diagnostic?: boolean,
  ): void {
    if (LEVELS[level] < LEVELS[this.level]) return;

    // Чистим сообщение — вырезаем секреты.
    const sanitizedMsg = sanitizeLogMessage(msg);
    const sanitizedMeta = meta ? this.sanitizeMeta(meta) : undefined;

    const ts = new Date().toISOString();
    const metaStr = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : "";

    const line = `${sanitizedMsg}${metaStr}`;
    try {
      this.sink.emit({
        level,
        // INV-13: именованный логер — `module:<prefix>`, корневой (без префикса) — `mma`.
        source: this.prefix ? moduleSource(this.prefix) : "mma",
        kind: "log",
        text: line,
        sessionId: this.sessionId ?? undefined,
        data: diagnostic ? { diagnostic: true } : undefined,
      });
    } catch {
      /* terminal output is best-effort; file logging below must still run */
    }

    // Поведение legacy v1: дубль в тегированный `.log` (сессионный или дневной).
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
          `${JSON.stringify({
            level,
            ts,
            prefix: this.prefix,
            msg: sanitizedMsg,
            meta: sanitizedMeta ?? null,
          })}\n`,
          "utf-8",
        );
      } catch {
        /* file logging is best-effort */
      }
    }
  }

  /** Рекурсивно чистит секреты в объекте метаданных. */
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
   * Структурная запись только в app.jsonl (без консоли и .log).
   * Для машиночитаемых отчётов (окружение и т.п.), слишком шумных для терминала,
   * но ценных для кросс-девайс диагностики.
   */
  logStructured(type: string, data: Record<string, unknown>): void {
    const logTarget = this.sessionDir ?? this.logDir;
    if (!logTarget) return;
    try {
      appendFileSync(
        join(logTarget, "app.jsonl"),
        `${JSON.stringify({
          level: "info",
          ts: new Date().toISOString(),
          type,
          meta: this.sanitizeMeta(data),
        })}\n`,
        "utf-8",
      );
    } catch {
      /* file logging is best-effort */
    }
  }

  /**
   * Запись только в app.jsonl — без консоли и .log. Для шумных подсистем
   * (LSP, пробники): предупреждения диагностируются по файлам сессии,
   * но не мусорят в терминале.
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
        `${JSON.stringify({
          level,
          ts,
          prefix: this.prefix,
          msg: sanitizedMsg,
          meta: sanitizedMeta ?? null,
        })}\n`,
        "utf-8",
      );
    } catch {
      /* file logging is best-effort */
    }
  }
}
