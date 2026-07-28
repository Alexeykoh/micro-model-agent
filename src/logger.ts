import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOGS_DIR = join(homedir(), ".mma", "logs");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB на файл
const MAX_LOG_FILES = 30; // макс. количество файлов в директории
const DEFAULT_MAX_DAYS = 30; // макс. возраст файла в днях
const TOOL_OUTPUT_LIMIT = 2000; // макс. символов вывода тула в логе

let _sessionLogPath: string | null = null;
let _statusWriter: ((msg: string) => void) | null = null;
let _logRenderer:
  ((level: string, tag: string, message: string) => void) | null = null;

export function setStatusWriter(writer: ((msg: string) => void) | null): void {
  _statusWriter = writer;
}

export function setLogRenderer(
  renderer: ((level: string, tag: string, message: string) => void) | null,
): void {
  _logRenderer = renderer;
}

export function writeStatus(msg: string): void {
  _statusWriter?.(msg);
}

function ensureDir(): void {
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

export function initSessionLog(sessionId: string): void {
  ensureDir();
  _sessionLogPath = join(LOGS_DIR, `${sessionId}.log`);
  cleanupOldLogs();
}

export function getLogPath(): string {
  if (_sessionLogPath) return _sessionLogPath;
  ensureDir();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return join(LOGS_DIR, `${date}.log`);
}

export function closeSessionLog(): void {
  _sessionLogPath = null;
}

function timestamp(): string {
  return new Date().toISOString();
}

/** Ротировать файл если превышен лимит размера */
function rotateIfNeeded(filePath: string): void {
  if (!existsSync(filePath)) return;
  const size = statSync(filePath).size;
  if (size < MAX_LOG_SIZE) return;

  let idx = 1;
  while (existsSync(`${filePath}.${idx}`)) idx++;
  renameSync(filePath, `${filePath}.${idx}`);
}

export function log(
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  tag: string,
  message: string,
): void {
  ensureDir();
  const fp = getLogPath();
  rotateIfNeeded(fp);
  const line = `[${timestamp()}] [${level}] [${tag}] ${message}\n`;
  appendFileSync(fp, line, "utf-8");
  _logRenderer?.(level, tag, message);
}

export function logInfo(tag: string, message: string): void {
  log("INFO", tag, message);
}
export function logWarn(tag: string, message: string): void {
  log("WARN", tag, message);
}
export function logError(tag: string, message: string): void {
  log("ERROR", tag, message);
}
export function logDebug(tag: string, message: string): void {
  log("DEBUG", tag, message);
}

export function logLLMRequest(
  model: string,
  messagesCount: number,
  promptPreview: string,
  caller?: string,
): void {
  const tag = caller ? `LLM/${caller}` : "LLM";
  logInfo(
    tag,
    `→ ${model} | ${messagesCount} messages | "${promptPreview.slice(0, 100)}"`,
  );
}

export function logLLMResponse(
  model: string,
  responseLength: number,
  genTimeMs: number,
  error?: string,
  caller?: string,
): void {
  const tag = caller ? `LLM/${caller}` : "LLM";
  if (error) {
    logError(
      tag,
      `← ${model} | ${responseLength} chars | ${genTimeMs}ms | ERROR: ${error}`,
    );
  } else {
    logInfo(tag, `← ${model} | ${responseLength} chars | ${genTimeMs}ms`);
  }
}

export function logToolCall(
  tool: string,
  preview: string,
  result?: string,
): void {
  const previewTrimmed =
    preview.length > 200 ? preview.slice(0, 200) + "..." : preview;
  if (result !== undefined) {
    const resultTrimmed =
      result.length > 200 ? result.slice(0, 200) + "..." : result;
    logInfo("TOOL", `${tool} | ${previewTrimmed} → ${resultTrimmed}`);
  } else {
    logInfo("TOOL", `${tool} | ${previewTrimmed}`);
  }
}

/** Запись полного вывода тула в лог (уровень DEBUG) */
export function logToolOutput(
  tool: string,
  output: string,
  exitCode: number,
): void {
  const trimmed =
    output.length > TOOL_OUTPUT_LIMIT
      ? output.slice(0, TOOL_OUTPUT_LIMIT) +
        `\n... (truncated ${output.length - TOOL_OUTPUT_LIMIT} chars)`
      : output;
  logDebug("TOOL_OUTPUT", `${tool} exit:${exitCode}\n${trimmed}`);
}

export function logREPL(
  tag: "user" | "assistant" | "system",
  content: string,
): void {
  const trimmed =
    content.length > 400 ? content.slice(0, 400) + "..." : content;
  logInfo(`REPL/${tag}`, trimmed);
}

/**
 * Очистка старых логов.
 * - Удаляет файлы старше maxDays
 * - Оставляет не более maxFiles самых свежих .log файлов
 */
export function cleanupOldLogs(
  maxDays = DEFAULT_MAX_DAYS,
  maxFiles = MAX_LOG_FILES,
): void {
  ensureDir();
  const now = Date.now();

  // 1. Удалить по возрасту
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith(".log") || /\.log\.\d+$/.test(f))
    .map((f) => ({
      name: f,
      path: join(LOGS_DIR, f),
      mtime: statSync(join(LOGS_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const f of files) {
    if (now - f.mtime > maxDays * 24 * 60 * 60 * 1000) {
      try {
        unlinkSync(f.path);
      } catch {
        /* ignore */
      }
    }
  }

  // 2. Удалить лишние (свежие, но больше maxFiles штук)
  const remaining = readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith(".log") || /\.log\.\d+$/.test(f))
    .map((f) => ({
      name: f,
      path: join(LOGS_DIR, f),
      mtime: statSync(join(LOGS_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  for (let i = maxFiles; i < remaining.length; i++) {
    try {
      unlinkSync(remaining[i].path);
    } catch {
      /* ignore */
    }
  }
}
