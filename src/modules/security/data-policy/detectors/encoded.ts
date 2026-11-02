/**
 * Детектор значений, спрятанных в base64 (долг `encoded-value-bypass`).
 *
 * DLP матчит исходный текст, поэтому `QzpcXHdvcmtcAXByb2o...` (base64 от
 * `C:\work\proj`) раньше уходил как обычная строка. Здесь мы декодируем
 * **только канонические base64-блоки** и проверяем результат на уже известные
 * машинные значения и на форму секрета — без общего декодера всех подстрок
 * (это было бы O(n²) и давало бы ложные срабатывания).
 *
 * Сознательно не трогаем «split» (значение, разбитое разделителями): там нет
 * надёжного признака, а склейка соседних кусков даёт ложные пути.
 */
import type { PolicyContext } from "../context";
import type { Finding } from "../types";

/** base64-блок: минимум 16 символов, выравнивание `=` допускается. */
const B64_RE = /[A-Za-z0-9+/]{16,}={0,2}/g;

/** Сколько кандидатов разбирать на одну строку (защита от квадратичности). */
const MAX_CANDIDATES = 32;

/** Декодированный кусок длиннее этого не рассматриваем. */
const MAX_DECODED = 4096;

/** Явная форма секрета в декодированном тексте. */
const SECRET_RE = /(sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S{8,})/i;

/** Декодировать base64 → строка; `undefined`, если это не текст. */
function decode(blob: string): string | undefined {
  try {
    const buf = Buffer.from(blob, "base64");
    if (buf.length === 0 || buf.length > MAX_DECODED) return undefined;
    const text = buf.toString("utf8");
    // Произвольный бинарь даёт мусор с символами замены — это не утечка.
    if (text.includes("\uFFFD")) return undefined;
    return text;
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

/** Находки base64-обёрток известных значений/секретов. */
export function detectEncoded(text: string, ctx: PolicyContext): Finding[] {
  const out: Finding[] = [];
  let seen = 0;
  for (const match of text.matchAll(B64_RE)) {
    if (seen >= MAX_CANDIDATES) break;
    seen += 1;
    const blob = match[0];
    const start = match.index ?? 0;
    const decoded = decode(blob);
    if (!decoded) continue;
    if (SECRET_RE.test(decoded)) {
      out.push({
        dataClass: "secret",
        kind: "encoded-secret",
        start,
        end: start + blob.length,
        confidence: 0.9,
        redact: false,
      });
      continue;
    }
    const machine = machineClass(decoded, ctx);
    if (machine) {
      out.push({
        dataClass: machine.dataClass,
        kind: machine.kind,
        start,
        end: start + blob.length,
        confidence: 0.9,
        redact: true,
      });
    }
  }
  return out;
}
