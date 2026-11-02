/**
 * Детектор значений, спрятанных в кодировке (долг `encoded-value-bypass`).
 *
 * DLP матчит исходный текст, поэтому base64/hex/percent-encoded значение раньше
 * уходило как обычная строка. Здесь декодируются **только канонические блоки**
 * и проверяется результат: известные машинные значения и явная форма секрета.
 * Общего декодера всех подстрок нет — это было бы O(n²) и дало бы ложные
 * срабатывания на произвольном тексте.
 *
 * Не покрыто сознательно: split-обфускация (отдельный `joined.ts`), rot13,
 * гомоглифы — у них нет надёжного признака.
 */
import type { PolicyContext } from "../context";
import type { Finding } from "../types";

/** base64/base64url блок: минимум 16 символов, выравнивание `=` допускается. */
const B64_RE = /[A-Za-z0-9+/\-_]{16,}={0,2}/g;
/** hex-блок: минимум 8 байт (16 hex-символов). */
const HEX_RE = /(?:[0-9A-Fa-f]{2}){8,}/g;
/** percent-encoded блок: минимум 4 байта. */
const PERCENT_RE = /(?:%[0-9A-Fa-f]{2}){4,}/g;

/** Сколько кандидатов разбирать на одну строку (защита от квадратичности). */
const MAX_CANDIDATES = 32;
/** Декодированный кусок длиннее этого не рассматриваем. */
const MAX_DECODED = 4096;
/** Минимальная доля печатных символов в декодированном тексте. */
const MIN_PRINTABLE = 0.85;

/** Явная форма секрета в декодированном тексте. */
const SECRET_RE = /(sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S{8,})/i;

/** Секрет, спрятанный в base64/hex/percent. */
function asSecret(decoded: string): boolean {
  return SECRET_RE.test(decoded);
}

/** Доля печатных символов: бинарь после декодирования — не утечка. */
function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let ok = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) ok += 1;
  }
  return ok / text.length;
}

/** Декодировать в текст; `undefined`, если получился бинарь/пусто. */
function decodeText(buf: Buffer): string | undefined {
  if (buf.length === 0 || buf.length > MAX_DECODED) return undefined;
  const text = buf.toString("utf8");
  if (text.includes("\uFFFD")) return undefined;
  if (printableRatio(text) < MIN_PRINTABLE) return undefined;
  return text;
}

function decodeBase64(blob: string): string | undefined {
  try {
    // base64url: `-`/`_` вместо `+`/`/` — иначе строка просто не декодируется.
    const normalized = blob.replace(/-/g, "+").replace(/_/g, "/");
    return decodeText(Buffer.from(normalized, "base64"));
  } catch {
    return undefined;
  }
}

function decodeHex(blob: string): string | undefined {
  try {
    return decodeText(Buffer.from(blob, "hex"));
  } catch {
    return undefined;
  }
}

function decodePercent(blob: string): string | undefined {
  try {
    return decodeText(Buffer.from(decodeURIComponent(blob), "utf8"));
  } catch {
    return undefined;
  }
}

/** Найти известное машинное значение в декодированном тексте. */
function machineClass(
  decoded: string,
  ctx: PolicyContext,
): { dataClass: Finding["dataClass"]; kind: string } | undefined {
  const values: Array<[string | undefined, Finding["dataClass"], string]> = [
    [ctx.baseDir, "path", "encoded-path"],
    [ctx.home, "path", "encoded-path"],
    [ctx.hostname, "machine", "encoded-host"],
    [ctx.username, "machine", "encoded-user"],
  ];
  for (const [value, dataClass, kind] of values) {
    if (value && value.length >= 4 && decoded.toLowerCase().includes(value.toLowerCase())) {
      return { dataClass, kind };
    }
  }
  return undefined;
}

/** Оценить блок: находка или `undefined`. */
function judge(
  blob: string,
  start: number,
  decoded: string | undefined,
  ctx: PolicyContext,
): Finding | undefined {
  if (!decoded) return undefined;
  const span = { start, end: start + blob.length };
  if (asSecret(decoded)) {
    return {
      dataClass: "secret",
      kind: "encoded-secret",
      ...span,
      confidence: 0.9,
      redact: false,
    };
  }
  const machine = machineClass(decoded, ctx);
  if (!machine) return undefined;
  return {
    dataClass: machine.dataClass,
    kind: machine.kind,
    ...span,
    confidence: 0.9,
    redact: true,
  };
}

/** Пройти по блокам одного формата и собрать находки. */
function scan(
  text: string,
  re: RegExp,
  decode: (blob: string) => string | undefined,
  ctx: PolicyContext,
): Finding[] {
  const out: Finding[] = [];
  let seen = 0;
  re.lastIndex = 0;
  for (const match of text.matchAll(re)) {
    if (seen >= MAX_CANDIDATES) break;
    seen += 1;
    const blob = match[0];
    const start = match.index ?? 0;
    const finding = judge(blob, start, decode(blob), ctx);
    if (finding) out.push(finding);
  }
  return out;
}

/** Находки закодированных известных значений/секретов. */
export function detectEncoded(text: string, ctx: PolicyContext): Finding[] {
  return [
    ...scan(text, HEX_RE, decodeHex, ctx),
    ...scan(text, PERCENT_RE, decodePercent, ctx),
    ...scan(text, B64_RE, decodeBase64, ctx),
  ];
}
