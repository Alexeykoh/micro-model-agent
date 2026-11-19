/**
 * Детектор «склеенного» значения: split по пробелам/кавычкам/`+`/переводам строк
 * и zero-width символы разрывают известный путь или имя машины на куски, и
 * построчный матчер его не видит.
 *
 * Подход: строим компактную копию текста без разделителей, **с картой индексов
 * обратно в оригинал**, и ищем в ней известные значения из `PolicyContext`.
 * Маска ставится на исходный диапазон (вместе с разделителями внутри) — это
 * честно: значение целиком вырезано, а не «половина».
 *
 * Границы: ищем только известные значения (а не произвольные паттерны), чтобы
 * склейка слов не давала ложных путей. Секрет, разорванный пополам без
 * разделителя, остаётся residual risk.
 */
import type { PolicyContext } from "../context";
import type { Finding } from "../types";
import { detectSecrets } from "./secrets";

/** Максимум находок одного вида на строку. */
const MAX_JOINED = 32;
/** Минимальная длина значения: короткие дают ложные совпадения при склейке. */
const MIN_VALUE = 6;

/** Разделитель, который МОЖЕТ стоять внутри разорванного значения. */
function isJoiner(ch: string): boolean {
  if (/\s/.test(ch)) return true;
  return ch === "+" || ch === "`" || ch === '"' || ch === "'" || ch === "\u200B" ||
    ch === "\u200C" || ch === "\u200D" || ch === "\uFEFF";
}

/** Кириллические гомоглифы латиницы: обход «визуально тот же путь». */
const HOMOGLYPHS: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c",
  "\u0443": "y", "\u0445": "x", "\u043A": "k", "\u043C": "m", "\u043D": "h",
  "\u0432": "b", "\u0442": "t",
  "\u0410": "A", "\u0415": "E", "\u041E": "O", "\u0420": "P", "\u0421": "C",
  "\u0423": "Y", "\u0425": "X", "\u041A": "K", "\u041C": "M", "\u041D": "H",
  "\u0412": "B", "\u0422": "T",
};

/** Символ к сопоставимому ASCII: fullwidth и гомоглифы (1:1). */
function foldChar(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  // Fullwidth ASCII (U+FF01..U+FF5E) → обычный ASCII.
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  if (ch === "\u3000") return " ";
  return HOMOGLYPHS[ch] ?? ch;
}

interface Compact {
  text: string;
  /** map[i] — индекс в оригинале для символа compact[i]. */
  map: number[];
}

/** Текст + карта позиций обратно в оригинал. */
interface Mapped {
  text: string;
  map: number[];
}

/** Раскодировать `%XX` один раз, сохраняя карту в исходные позиции. */
function decodePercentOnce(input: Mapped): Mapped {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < input.text.length; i++) {
    const ch = input.text[i];
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(input.text.slice(i + 1, i + 3))) {
      const code = Number.parseInt(input.text.slice(i + 1, i + 3), 16);
      out += String.fromCharCode(code);
      map.push(input.map[i]);
      i += 2;
      continue;
    }
    out += ch;
    map.push(input.map[i]);
  }
  return { text: out, map };
}

/**
 * Декодировать percent-encoding (до двух раундов: `%253A` — двойное
 * экранирование). Карта композируется, чтобы маска встала на исходный диапазон.
 */
function decodePercent(input: Mapped, rounds = 2): Mapped {
  let cur = input;
  for (let r = 0; r < rounds; r++) {
    if (!/%[0-9A-Fa-f]{2}/.test(cur.text)) break;
    const next = decodePercentOnce(cur);
    if (next.text === cur.text) break;
    cur = next;
  }
  return cur;
}

/** Декодировать percent-encoding в строке (до двух раундов), без карты. */
export function decodePercentText(text: string): string {
  const mapped = decodePercent({
    text,
    map: Array.from({ length: text.length }, (_, i) => i),
  });
  return mapped.text;
}

/**
 * Компактная копия без разделителей + карта обратно в оригинал.
 * Сначала снимается percent-encoding, затем выбрасываются разделители
 * (пробелы/кавычки/`+`/zero-width), а удвоенные обратные слэши (JSON-экранирование
 * `C:\\\\work`) сводятся к одному — иначе путь не совпадёт с известным значением.
 */
export function compactWithMap(text: string): Compact {
  let stage: Mapped = {
    text,
    map: Array.from({ length: text.length }, (_, i) => i),
  };
  stage = decodePercent(stage);

  let out = "";
  const map: number[] = [];
  let prev = "";
  for (let i = 0; i < stage.text.length; i++) {
    const raw = stage.text[i];
    if (isJoiner(raw)) continue;
    const ch = foldChar(raw);
    if (ch === "\\" && prev === "\\") continue;
    out += ch;
    map.push(stage.map[i]);
    prev = ch;
  }
  return { text: out, map };
}

/** Найти все вхождения значения (регистронезависимо), с капом. */
function findOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let from = 0;
  while (out.length < MAX_JOINED) {
    const idx = h.indexOf(n, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + Math.max(1, n.length);
  }
  return out;
}

/** Находки разорванных известных значений. */
export function detectJoined(text: string, ctx: PolicyContext): Finding[] {
  if (text.length < MIN_VALUE) return [];
  const compact = compactWithMap(text);
  // Ничего не склеивали — обычные детекторы уже всё видят.
  if (compact.text === text) return [];

  const values: Array<[string | undefined, Finding["dataClass"], string]> = [
    [ctx.baseDir, "path", "joined-path"],
    [ctx.home, "path", "joined-path"],
    [ctx.hostname, "machine", "joined-host"],
    [ctx.username, "machine", "joined-user"],
  ];

  const out: Finding[] = [];
  for (const [value, dataClass, kind] of values) {
    if (!value || value.length < MIN_VALUE) continue;
    for (const idx of findOccurrences(compact.text, value)) {
      const start = compact.map[idx];
      const end = compact.map[idx + value.length - 1] + 1;
      if (start === undefined || end === undefined) continue;
      // Уже непрерывное вхождение — это работа обычных детекторов.
      if (end - start === value.length) continue;
      out.push({ dataClass, kind, start, end, confidence: 0.85, redact: true });
    }
  }

  // Секрет, разорванный разделителями (`sk-abcd` + `efgh`) или спрятанный за
  // percent-encoding: ищем его форму в склеенном тексте и переводим позиции
  // обратно. Непрерывные совпадения дедуп отсеет сам (тот же диапазон).
  for (const found of detectSecrets(compact.text)) {
    const start = compact.map[found.start];
    const end = compact.map[found.end - 1] + 1;
    if (start === undefined || end === undefined) continue;
    out.push({ ...found, start, end });
  }
  return out;
}
