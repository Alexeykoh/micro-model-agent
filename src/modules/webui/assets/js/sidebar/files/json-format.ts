// Форматирование JSON/JSONC для read-only просмотрщика файлов.
//
// Вьюер показывает файл таким, как он пришёл с /api/file. Минимизированный
// JSON (одна строка) нечитаем, поэтому здесь он разворачивается с отступами.
// Форматтер сохраняет строки и комментарии JSONC как есть, меняется только
// значимый пробел/отступ. Вместе с текстом отдаётся карта строк: переход из LSP
// («открыть файл на строке N») должен попадать в ту же строку исходника.

/** Результат форматирования: видимый текст + номер строки в нём для каждой исходной. */
export interface FormattedJson {
  text: string;
  /** lineMap[sourceLine - 1] = displayLine (1-based). */
  lineMap: number[];
}

const INDENT = "  ";

/** Позиции начала строк исходника — по ним снимается карта строк. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n" && i + 1 < source.length) starts.push(i + 1);
  }
  return starts;
}

/**
 * Разворачивает JSON/JSONC в канонический вид с двумя пробелами на уровень.
 * Строки, escape-последовательности и оба вида комментариев не трогаются;
 * невалидный ввод тоже приводится к аккуратному виду, без выброса.
 */
export function formatJson(source: string): FormattedJson {
  const starts = lineStarts(source);
  const lineMap: number[] = [];
  let nextStart = 0;
  let pendingLine = -1; // исходная строка, ждёт первого значимого символа
  let displayLine = 1;
  let indent = 0;
  let out = "";

  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let skip = 0;

  const newline = (): void => {
    out += "\n" + INDENT.repeat(indent);
    displayLine += 1;
  };
  const dropIndent = (): void => {
    out = out.replace(/[ \t]*$/, "");
  };
  /** Привязать исходную строку к строке отображения перед её первым токеном. */
  const bind = (): void => {
    if (pendingLine >= 0) {
      lineMap[pendingLine] = displayLine;
      pendingLine = -1;
    }
  };

  for (let i = 0; i < source.length; i += 1) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    if (nextStart < starts.length && starts[nextStart] === i) {
      // Пустая исходная строка: привязываем её к текущей строке отображения.
      if (pendingLine >= 0) lineMap[pendingLine] = displayLine;
      pendingLine = nextStart;
      nextStart += 1;
    }
    const c = source[i];
    const n = source[i + 1];

    if (inLineComment) {
      if (c === "\n") {
        dropIndent();
        newline();
        inLineComment = false;
      } else {
        bind();
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        bind();
        out += "*/";
        skip = 1;
        inBlockComment = false;
      } else if (c === "\n") {
        dropIndent();
        newline();
      } else {
        bind();
        out += c;
      }
      continue;
    }
    if (inString) {
      bind();
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      bind();
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      bind();
      inLineComment = true;
      out += "//";
      skip = 1;
      continue;
    }
    if (c === "/" && n === "*") {
      bind();
      inBlockComment = true;
      out += "/*";
      skip = 1;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === "{" || c === "[") {
      bind();
      out += c;
      indent += 1;
      newline();
      continue;
    }
    if (c === "}" || c === "]") {
      indent = Math.max(0, indent - 1);
      // Убрать отступ, который поставили перед «следующим элементом».
      out = out.replace(/\n[ \t]*$/, "");
      const prev = out[out.length - 1];
      if (prev === "{" || prev === "[") {
        bind();
        out += c; // пустой контейнер: {}
      } else {
        newline();
        bind();
        out += c;
      }
      continue;
    }
    bind();
    if (c === ",") {
      out += c;
      newline();
    } else if (c === ":") out += ": ";
    else out += c;
  }

  bind();
  while (lineMap.length < starts.length) lineMap.push(displayLine);
  return { text: out, lineMap };
}

/** Номер строки в показанном тексте для номера строки исходного файла. */
export function mapLine(lineMap: readonly number[], sourceLine: number): number {
  return lineMap[sourceLine - 1] ?? sourceLine;
}
