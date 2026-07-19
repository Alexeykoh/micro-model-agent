import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Логирование в файл.
 *
 * Все логи пишутся в ~/.mma/logs/:
 * - Сессионные логи: <sessionId>.log
 * - Дневные логи: YYYY-MM-DD.log
 *
 * Уровни: INFO, WARN, ERROR, DEBUG.
 * Специальные логи: LLM request/response, tool calls.
 *
 * @module logger
 */

const LOGS_DIR = join(homedir(), '.mma', 'logs');

let _sessionLogPath: string | null = null;
let _statusWriter: ((msg: string) => void) | null = null;

export function setStatusWriter(writer: ((msg: string) => void) | null): void {
  _statusWriter = writer;
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

export function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', tag: string, message: string): void {
  ensureDir();
  const line = `[${timestamp()}] [${level}] [${tag}] ${message}\n`;
  appendFileSync(getLogPath(), line, 'utf-8');
}

export function logInfo(tag: string, message: string): void { log('INFO', tag, message); }
export function logWarn(tag: string, message: string): void { log('WARN', tag, message); }
export function logError(tag: string, message: string): void { log('ERROR', tag, message); }
export function logDebug(tag: string, message: string): void { log('DEBUG', tag, message); }

export function logLLMRequest(model: string, messagesCount: number, promptPreview: string, caller?: string): void {
  const tag = caller ? `LLM/${caller}` : 'LLM';
  logInfo(tag, `→ ${model} | ${messagesCount} messages | "${promptPreview.slice(0, 100)}"`);
}

export function logLLMResponse(model: string, responseLength: number, genTimeMs: number, error?: string, caller?: string): void {
  const tag = caller ? `LLM/${caller}` : 'LLM';
  if (error) {
    logError(tag, `← ${model} | ${responseLength} chars | ${genTimeMs}ms | ERROR: ${error}`);
  } else {
    logInfo(tag, `← ${model} | ${responseLength} chars | ${genTimeMs}ms`);
  }
}

export function logToolCall(tool: string, preview: string, result?: string): void {
  const previewTrimmed = preview.length > 80 ? preview.slice(0, 80) + '...' : preview;
  if (result !== undefined) {
    const resultTrimmed = result.length > 100 ? result.slice(0, 100) + '...' : result;
    logInfo('TOOL', `${tool} | ${previewTrimmed} → ${resultTrimmed}`);
  } else {
    logInfo('TOOL', `${tool} | ${previewTrimmed}`);
  }
}

export function logREPL(tag: 'user' | 'assistant' | 'system', content: string): void {
  const trimmed = content.length > 200 ? content.slice(0, 200) + '...' : content;
  logInfo(`REPL/${tag}`, trimmed);
}

export function cleanupOldLogs(maxDays = 7): void {
  ensureDir();
  const { readdirSync, unlinkSync } = require('node:fs') as typeof import('node:fs');
  const now = Date.now();
  for (const file of readdirSync(LOGS_DIR)) {
    if (!file.endsWith('.log')) continue;
    const filePath = join(LOGS_DIR, file);
    const stat = existsSync(filePath) ? require('node:fs').statSync(filePath) : null;
    if (stat && (now - stat.mtimeMs) > maxDays * 24 * 60 * 60 * 1000) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
}
