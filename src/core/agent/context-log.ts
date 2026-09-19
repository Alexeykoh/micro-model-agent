// src/core/agent/context-log
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
const CONTEXT_LINES = 3;
// Ограничение на размер LCS-матрицы. При большем «середине» diff деградирует
// до полной замены, чтобы не аллоцировать сотни МБ.
const MAX_LCS_CELLS = 4_000_000;

export interface ContextLogMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  success?: boolean;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export interface ContextLogTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ContextLogMeta {
  iteration: number;
  ts: string;
  systemTokens: number;
  toolTokens: number;
  historyTokens: number;
  totalTokens: number;
  contextWindow: number;
}

export interface ContextLogOutput {
  reasoning?: string;
  text?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
  iteration: number;
  ts: string;
}

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

interface DiffOp {
  type: " " | "-" | "+";
  line: string;
}

function safeJson(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentLines(content: unknown): string[] {
  if (content == null) return [""];
  if (typeof content === "string") return content.length > 0 ? content.split("\n") : [""];
  if (Array.isArray(content)) {
    const lines: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") {
          lines.push(...(p.text.length > 0 ? p.text.split("\n") : [""]));
        } else if (p.type === "image_url") {
          lines.push("[image]");
        } else {
          lines.push(safeJson(part));
        }
      } else {
        lines.push(String(part));
      }
    }
    return lines.length > 0 ? lines : [""];
  }
  return [String(content)];
}

/**
 * Каноническое многострочное представление отправляемого контекста.
 * Порядок фиксирован: system → tools → history. Стабильный формат — залог
 * осмысленного diff между итерациями.
 */
export function serializeContextForLog(
  messages: ContextLogMessage[],
  tools: ContextLogTool[],
): string {
  const out: string[] = [];
  const system: ContextLogMessage[] = [];
  const rest: ContextLogMessage[] = [];
  for (const m of messages) (m.role === "system" ? system : rest).push(m);

  out.push("[SYSTEM]");
  if (system.length === 0) {
    out.push("(none)");
  } else {
    for (const m of system) out.push(...contentLines(m.content));
  }

  out.push("");
  out.push("[TOOLS]");
  if (tools.length === 0) {
    out.push("(none)");
  } else {
    for (const tool of tools) {
      out.push(`${tool.name} | ${tool.description} | ${safeJson(tool.parameters)}`);
    }
  }

  out.push("");
  out.push("[HISTORY]");
  if (rest.length === 0) {
    out.push("(empty)");
  } else {
    for (const m of rest) {
      const head = [`role=${m.role}`];
      if (m.tool_call_id) head.push(`id=${m.tool_call_id}`);
      if (m.name) head.push(`name=${m.name}`);
      if (m.success !== undefined) head.push(`success=${m.success}`);
      out.push(head.join(" "));

      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name ?? "?";
          const args = tc.function?.arguments;
          out.push(`  → ${name} ${typeof args === "string" ? args : safeJson(args)}`);
        }
      }
      out.push(...contentLines(m.content));
      out.push("");
    }
  }

  return out.join("\n");
}

function commonPrefixLen(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string[], b: string[], prefix: number): number {
  const max = Math.min(a.length - prefix, b.length - prefix);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** LCS-дифф для средней части (уже без общего префикса/суффикса). */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ type: "+" as const, line }));
  if (m === 0) return a.map((line) => ({ type: "-" as const, line }));

  if (n * m > MAX_LCS_CELLS) {
    const ops: DiffOp[] = [];
    for (const line of a) ops.push({ type: "-", line });
    for (const line of b) ops.push({ type: "+", line });
    return ops;
  }

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: "-", line: a[i] });
      i++;
    } else {
      ops.push({ type: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "-", line: a[i++] });
  while (j < m) ops.push({ type: "+", line: b[j++] });
  return ops;
}

function renderHunks(ops: DiffOp[], context: number): string[] {
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== " ") changed.push(i);
  }
  if (changed.length === 0) return [];

  // Номера строк до/после для каждого op.
  const oldNum = new Array<number>(ops.length);
  const newNum = new Array<number>(ops.length);
  let o = 1;
  let nw = 1;
  for (let i = 0; i < ops.length; i++) {
    oldNum[i] = o;
    newNum[i] = nw;
    if (ops[i].type === " ") {
      o++;
      nw++;
    } else if (ops[i].type === "-") {
      o++;
    } else {
      nw++;
    }
  }

  const groups: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - end <= context * 2) {
      end = changed[k];
    } else {
      groups.push([start, end]);
      start = changed[k];
      end = changed[k];
    }
  }
  groups.push([start, end]);

  const hunks: string[] = [];
  for (const [s, e] of groups) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length - 1, e + context);
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op.type !== "+") oldCount++;
      if (op.type !== "-") newCount++;
      body.push(`${op.type}${op.line}`);
    }
    hunks.push(`@@ -${oldNum[from]},${oldCount} +${newNum[from]},${newCount} @@`);
    hunks.push(...body);
  }
  return hunks;
}

/**
 * Плоский unified diff без ANSI и truncation.
 * `prev`/`next` — многострочный текст. Возвращает "" при отсутствии изменений.
 */
export function unifiedDiff(
  prev: string,
  next: string,
  context = CONTEXT_LINES,
  fromLabel = "a",
  toLabel = "b",
): string {
  if (prev === next) return "";

  const a = prev.split("\n");
  const b = next.split("\n");

  const prefix = commonPrefixLen(a, b);
  const suffix = commonSuffixLen(a, b, prefix);

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const midOps = lcsOps(midA, midB);

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ type: " ", line: a[i] });
  ops.push(...midOps);
  for (let i = suffix; i > 0; i--) ops.push({ type: " ", line: a[a.length - i] });

  const hunks = renderHunks(ops, context);
  if (hunks.length === 0) return "";
  return [`--- ${fromLabel}`, `+++ ${toLabel}`, ...hunks].join("\n");
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
      appendFileSync(this.path, text.endsWith("\n") ? text : text + "\n", "utf8");
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
    // no-op
  }
}
