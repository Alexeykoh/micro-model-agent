/** Git-подобный лог контекста LLM: snapshot'ы и diff между итерациями. */
/**
 * Запись всего контекста, уходящего в LLM, в git-подобный diff-файл.
 *
 * Формат: snapshot 0 — полный контекст (каждая строка с "+", как новый файл в
 * git); каждый следующий snapshot — построчный diff относительно предыдущего
 * ("-" удалено, "+" добавлено). Секции канонического текста: [SYSTEM],
 * [TOOLS], [HISTORY].
 *
 * Reasoning модели НЕ входит в контекст, отправляемый в LLM, поэтому он пишется
 * отдельной аннотацией [OUTPUT] и в diff не участвует.
 *
 * Секреты редактируются общим sanitizeLogMessage (если redact=true).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import type { ContextLogMessage, ContextLogTool } from "./context-log-diff";
import { CONTEXT_LINES, safeJson, serializeContextForLog, unifiedDiff } from "./context-log-diff";

export type { ContextLogMessage, ContextLogTool } from "./context-log-diff";
export { CONTEXT_LINES, serializeContextForLog, unifiedDiff } from "./context-log-diff";

/**
 * Точечная редакция секретов для context-log.
 *
 * НЕ используем общий sanitizeLogMessage: его generic-паттерн (любая строка
 * 30+ символов) и слишком широкий `pass` вырезают обычный текст контекста —
 * имена скилов, "pass a file", `pass "background: true"` — что делает
 * отладочный лог бесполезным. Здесь только безошибочно опознаваемые секреты.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]"],
  [/\bctx7sk-[A-Za-z0-9_-]{10,}\b/g, "ctx7sk-[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[JWT REDACTED]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/gi, "$1 [REDACTED]"],
  [
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key)\b(["']?\s*[=:]\s*["']?)([A-Za-z0-9_\-./+]{16,})/gi,
    "$1$2[REDACTED]",
  ],
  [/\b(password|passwd)\b(["']?\s*[=:]\s*["']?)([^\s"'&]{8,})/gi, "$1$2[REDACTED]"],
];

/** Заменяет только безошибочно опознаваемые секреты, не трогая обычный текст. */
export function redactContextSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Версия протокола заголовка — растёт при несовместимом изменении формата. */
export const CONTEXT_LOG_FORMAT = 1;

const BAR = "═".repeat(78);
const SEP = "─".repeat(78);

/** Мета snapshot'а: итерация, время, токены по секциям. */
export interface ContextLogMeta {
  iteration: number;
  ts: string;
  systemTokens: number;
  toolTokens: number;
  historyTokens: number;
  totalTokens: number;
  contextWindow: number;
}

/** Вывод модели для [OUTPUT]-аннотации (в контекст LLM не входит). */
export interface ContextLogOutput {
  reasoning?: string;
  text?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  iteration: number;
  ts: string;
}

/** Опции логгера: путь, сессия, модель, окно, редакция секретов. */
export interface ContextLoggerOptions {
  path: string;
  sessionId: string;
  model: string;
  contextWindow: number;
  /** Идентификатор запуска процесса (обычно pid) — для run-разделителя. */
  runId?: number;
  redact?: boolean;
  /** Инъекция времени — для детерминированных тестов. */
  now?: () => Date;
}

/**
 * Пишет git-подобный лог контекста в append-only файл.
 */
export class ContextLogger {
  private readonly path: string;
  private readonly sessionId: string;
  private readonly model: string;
  private readonly contextWindow: number;
  private readonly runId: number;
  private readonly redact: boolean;
  private readonly now: () => Date;

  private prev: string | null = null;
  private snapshotIndex = 0;
  private headerWritten = false;
  private outputIndex = 0;

  constructor(opts: ContextLoggerOptions) {
    this.path = opts.path;
    this.sessionId = opts.sessionId;
    this.model = opts.model;
    this.contextWindow = opts.contextWindow;
    this.runId = opts.runId ?? process.pid;
    this.redact = opts.redact !== false;
    this.now = opts.now ?? (() => new Date());
  }

  get filePath(): string {
    return this.path;
  }

  private ensureHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;

    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      // best-effort: appendFileSync ниже сообщит об ошибке
    }

    const exists = existsSync(this.path);
    let existing = "";
    if (exists) {
      try {
        existing = readFileSync(this.path, "utf8");
      } catch {
        existing = "";
      }
    }

    // Продолжаем нумерацию snapshot'ов, если файл уже есть.
    const matches = existing.match(/### snapshot (\d+)/g);
    if (matches && matches.length > 0) {
      const last = matches[matches.length - 1].match(/### snapshot (\d+)/);
      if (last) this.snapshotIndex = Number(last[1]) + 1;
    }

    if (existing.trim().length > 0) {
      const runHeader = [
        "",
        BAR,
        `===== run ${this.runId} · ${this.now().toISOString()} · session ${this.sessionId} =====`,
        SEP,
        "",
      ].join("\n");
      this.append(runHeader);
    } else {
      const header = [
        BAR,
        "mma context log",
        `session: ${this.sessionId}      model: ${this.model}      contextWindow: ${this.contextWindow}`,
        `run ${this.runId} · started ${this.now().toISOString()}`,
        "format:  snapshot 0 = full context (all lines \"+\"); later snapshots are line diffs",
        "         (- removed, + added). [OUTPUT] = model output, NOT part of the LLM context.",
        `secrets: ${this.redact ? "redacted" : "RAW"}`,
        BAR,
        "",
      ].join("\n");
      this.append(header);
    }
  }

  private append(text: string): void {
    try {
      appendFileSync(this.path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    } catch {
      // Логирование контекста не должно ронять агент.
    }
  }

  private sanitize(text: string): string {
    return this.redact ? redactContextSecrets(text) : text;
  }

  /** Записывает снимок отправляемого контекста (diff к предыдущему). */
  record(messages: ContextLogMessage[], tools: ContextLogTool[], meta: ContextLogMeta): void {
    this.ensureHeader();
    const text = this.sanitize(serializeContextForLog(messages, tools));
    const idx = this.snapshotIndex;
    const header =
      `### snapshot ${idx} · run ${this.runId} · iteration ${meta.iteration} · ${meta.ts} · ` +
      `${meta.totalTokens}/${meta.contextWindow} tok ` +
      `(system ${meta.systemTokens} · tools ${meta.toolTokens} · history ${meta.historyTokens})`;

    let block: string;
    if (this.prev === null) {
      const lines = text.split("\n");
      const body = lines.map((l) => `+${l}`).join("\n");
      block = `${header}\n--- /dev/null\n+++ b/context@${idx}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
    } else {
      const diff = unifiedDiff(this.prev, text, CONTEXT_LINES, `context@${idx - 1}`, `context@${idx}`);
      block = diff ? `${header}\n${diff}` : `${header}\n(context unchanged)`;
    }

    this.prev = text;
    this.snapshotIndex++;
    this.append(`\n${block}\n`);
  }

  /**
   * Аннотация вывода модели. Reasoning/текст/tool_calls НЕ входят в контекст
   * LLM для следующего запроса — поэтому это не diff, а плоская запись.
   */
  recordOutput(out: ContextLogOutput): void {
    const hasReasoning = !!out.reasoning?.trim();
    const hasText = !!out.text?.trim();
    const hasCalls = !!out.toolCalls && out.toolCalls.length > 0;
    if (!hasReasoning && !hasText && !hasCalls) return;

    this.ensureHeader();
    this.outputIndex++;

    const lines: string[] = [
      "",
      `[OUTPUT #${this.outputIndex} ← result of iteration ${out.iteration}, NOT part of the LLM context]`,
    ];
    if (hasReasoning) {
      lines.push("▍reasoning:");
      for (const line of this.sanitize(out.reasoning!).split("\n")) lines.push(`▍  ${line}`);
    }
    if (hasText) {
      lines.push("▍assistant text:");
      for (const line of this.sanitize(out.text!).split("\n")) lines.push(`▍  ${line}`);
    }
    if (hasCalls) {
      lines.push("▍tool_calls:");
      for (const call of out.toolCalls!) {
        lines.push(`▍  ${call.name} ${this.sanitize(safeJson(call.arguments))}`);
      }
    }

    this.append(lines.join("\n"));
  }

  /** Append-only логгер — закрывать нечего. Оставлено для симметрии API. */
  close(): void {
  }
}
