/**
 * Канонический текст контекста и git-подобный diff для context-log.
 *
 * Здесь живёт всё, что превращает сообщения/тулы в стабильный многострочный
 * текст и считает unified diff между итерациями. `ContextLogger` в
 * `context-log.ts` пишет результат в файл; формат и поведение diff'а — часть
 * публичного контракта (реэкспортируется из `context-log.ts`).
 */

/** Сообщение истории для лога контекста (роль, контент, тул-мета). */
export interface ContextLogMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  success?: boolean;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

/** Определение тула для секции [TOOLS] лога. */
export interface ContextLogTool {
  name: string;
  description: string;
  parameters: unknown;
}

const CONTEXT_LINES = 3;
// Ограничение на размер LCS-матрицы. При большем «середине» diff деградирует
// до полной замены, чтобы не аллоцировать сотни МБ.
const MAX_LCS_CELLS = 4_000_000;

/** JSON-представление без исключений: undefined → "", строка — как есть. */
export function safeJson(value: unknown): string {
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

interface DiffOp {
  type: " " | "-" | "+";
  line: string;
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

/** Контекстные строки вокруг изменений в diff-хаках. */
export { CONTEXT_LINES };
