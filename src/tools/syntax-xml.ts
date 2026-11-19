/**
 * Минимальная проверка XML well-formedness (без зависимостей): сканер со
 * стеком тегов, пропускает `<?...?>`, `<!--...-->`, `<![CDATA[...]]>` и
 * `<!...>`-декларации, учитывает кавычки в атрибутах (`>` внутри кавычек тег
 * не закрывает), репортит несогласованные/незакрытые/висячие теги.
 * Первая ошибка или null. Закрытый кейс: самозакрытый `<diagram/>` с висячим
 * `</diagram>` и заявлением "валидно".
 *
 * Разбит на мелкие сканеры, чтобы каждый юнит проходил complexity-гейт
 * (fallow pre-commit): спан comment/CDATA/PI, кавычко-чувствительный поиск
 * `>`, мэтчинг open/close, один markup-шаг на `<`.
 */
interface XmlSpan {
  end: number;
  kind: "comment" | "cdata" | "pi";
}

const XML_SPANS: Array<{ open: string; close: string; kind: XmlSpan["kind"] }> = [
  { open: "<!--", close: "-->", kind: "comment" },
  { open: "<![CDATA[", close: "]]>", kind: "cdata" },
  { open: "<?", close: "?>", kind: "pi" },
];

/** Спан коммента/CDATA/PI: конец (за закрывателем) или -1, если открыт. */
function skipXmlSpan(content: string, i: number): { end: number; kind: XmlSpan["kind"] } | null {
  for (const s of XML_SPANS) {
    if (!content.startsWith(s.open, i)) continue;
    const end = content.indexOf(s.close, i + s.open.length);
    return end === -1 ? { end: -1, kind: s.kind } : { end: end + s.close.length, kind: s.kind };
  }
  return null;
}

/**
 * Индекс за первым `>` вне кавычек, или -1. С trackBrackets (для `<!...>`
 * с `[...]`-секциями) `>` внутри скобок тоже пропускается.
 */
function findClosingGt(content: string, from: number, trackBrackets: boolean): number {
  let j = from;
  let quote: string | null = null;
  let depth = 0;
  while (j < content.length) {
    const d = content[j];
    quote = nextQuoteState(quote, d);
    if (quote) {
      j++;
      continue;
    }
    if (trackBrackets && d === "[") depth++;
    else if (trackBrackets && d === "]") depth--;
    else if (d === ">" && depth <= 0) return j + 1;
    j++;
  }
  return -1;
}

/** Кавычко-состояние на один символ: вход, выход или удержание спана. */
function nextQuoteState(quote: string | null, d: string): string | null {
  if (quote) return d === quote ? null : quote;
  return d === '"' || d === "'" ? d : null;
}

/** Сырой текст обычного `<...>`-тега плюс конечный индекс, или null. */
function readXmlTag(content: string, i: number): { raw: string; end: number } | null {
  const end = findClosingGt(content, i + 1, false);
  if (end === -1) return null;
  return { raw: content.slice(i + 1, end - 1).trim(), end };
}

/** Число переводов строк. */
function countLines(s: string): number {
  return s.split("\n").length - 1;
}

/** Состояние XML-скана: контент, позиция, строка, стек. */
interface XmlScanState {
  content: string;
  i: number;
  line: number;
  stack: Array<{ name: string; line: number }>;
}

/** Шаг через один `<...>`-элемент. Ошибка (без суффикса строки) или null. */
function scanXmlMarkup(st: XmlScanState): string | null {
  const { content } = st;
  const span = skipXmlSpan(content, st.i);
  if (span) {
    if (span.end === -1) return `Unclosed XML ${span.kind}`;
    st.line += countLines(content.slice(st.i, span.end));
    st.i = span.end;
    return null;
  }
  if (content.startsWith("<!", st.i)) {
    const end = findClosingGt(content, st.i + 2, true);
    if (end === -1) return "Unclosed declaration";
    st.line += countLines(content.slice(st.i, end));
    st.i = end;
    return null;
  }
  const tag = readXmlTag(content, st.i);
  if (!tag) return "Unclosed tag";
  st.line += countLines(content.slice(st.i, tag.end));
  st.i = tag.end;
  return matchXmlTag(st.stack, tag.raw, st.line);
}

/** Сверка закрывающего тега со стеком. Ошибка или null. */
function matchXmlCloseTag(stack: Array<{ name: string; line: number }>, raw: string): string | null {
  const name = raw.slice(1).split(/[\s/>]/, 1)[0];
  if (!name) return "Empty closing tag";
  const open = stack.pop();
  if (!open) return `Stray closing tag </${name}> with no open element`;
  if (open.name !== name) {
    return `Mismatched tag: expected </${open.name}> (opened line ${open.line}), got </${name}>`;
  }
  return null;
}

/** Сверка открывающего/самозакрытого тега со стеком. Ошибка или null. */
function matchXmlOpenTag(
  stack: Array<{ name: string; line: number }>,
  raw: string,
  tagLine: number,
): string | null {
  const selfClosed = /\/\s*$/.test(raw);
  const name = raw.split(/[\s/>]/, 1)[0];
  if (!name || name.startsWith("/") || name === "?") {
    return `Malformed tag <${raw.slice(0, 32)}>`;
  }
  if (!selfClosed) stack.push({ name, line: tagLine });
  return null;
}

/**
 * Сверка одного тега (open/self-close/close) со стеком. Стек мутирует, больше
 * ничего. Ошибка (без суффикса строки) или null.
 */
function matchXmlTag(
  stack: Array<{ name: string; line: number }>,
  raw: string,
  tagLine: number,
): string | null {
  if (!raw) return "Empty tag <>";
  if (raw.startsWith("/")) return matchXmlCloseTag(stack, raw);
  return matchXmlOpenTag(stack, raw, tagLine);
}

/** Проверяет XML well-formedness. Первая ошибка с номером строки или null. */
export function checkXmlWellFormed(content: string): string | null {
  const st: XmlScanState = { content, i: 0, line: 1, stack: [] };
  const err = (msg: string) => `${msg} (line ${st.line})`;
  while (st.i < content.length) {
    if (content[st.i] === "\n") {
      st.line++;
      st.i++;
      continue;
    }
    if (content[st.i] !== "<") {
      st.i++;
      continue;
    }
    const problem = scanXmlMarkup(st);
    if (problem) return err(problem);
  }
  if (st.stack.length > 0) {
    const open = st.stack[st.stack.length - 1];
    return err(`Unclosed tag <${open.name}> (opened line ${open.line})`);
  }
  return null;
}

/** Итог проверки XML: valid + текст первой ошибки. */
export interface XmlValidationResult {
  valid: boolean;
  error?: string;
}

/** XML-семейство — чистая well-formedness (компилятор не спавним). */
export function validateXmlContent(content: string): XmlValidationResult {
  const error = checkXmlWellFormed(content);
  return error ? { valid: false, error } : { valid: true };
}
