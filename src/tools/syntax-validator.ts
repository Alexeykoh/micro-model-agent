/** Превалидация синтаксиса перед записью (TS/JS/JSON/XML), без шелла. */
import { writeFileSync, existsSync, unlinkSync } from "fs";
import { extname, dirname } from "path";
import { spawn } from "child_process";
import { Logger } from "../logger/app-logger";

const SYNTAX_CACHE = new Map<string, { hash: string; error: string | null }>();
const logger = new Logger("warn", "syntax-validator");

/** Хэш контента для кэша проверок. */
function contentHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return String(h);
}

/**
 * Прогон компилятора с таймаутом. Успех — stdout/stderr, провал — throw.
 * Спавн БЕЗ шелла: путь файла от модели, интерполяция шелла выполнила бы
 * `$()`/бэктики/`%VAR%` в имени.
 */
function runCommand(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Syntax check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err: any = new Error(`Syntax check failed with exit code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.status = code;
        reject(err);
      }
    });
  });
}

/** Расширения с валидацией синтаксиса. */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".cts", ".mts"]);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".cjs", ".mjs"]);
const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);
/** XML-семейство: только well-formedness, без внешних зависимостей. */
const XML_EXTENSIONS = new Set([".xml", ".drawio", ".svg", ".xaml", ".plist", ".iml"]);

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

/**
 * Best-effort JSONC-нормалайзер: сносит `//` и `/* ... *\/`-комменты и висячие
 * запятые, чтобы валидный комментированный `tsconfig.json` не отклонялся
 * pre-write гейтом как syntax error (гейт заставлял малые модели сносить
 * нужные комменты).
 */
function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const n = input[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/** Итог валидации: valid + текст первой ошибки. */
export interface SyntaxValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Превалидация синтаксиса ДО записи на диск.
 * `{ valid: true }` — синтаксис ок или язык не поддерживается;
 * `{ valid: false, error }` — синтаксис бит.
 *
 * TypeScript/JavaScript: временный файл + прогон компилятора.
 * JSON: прямой парсинг.
 */
export async function preValidateSyntax(
  filePath: string,
  content: string,
  _baseDir: string,
): Promise<SyntaxValidationResult> {
  const ext = extname(filePath).toLowerCase();

  // JSON / JSONC — прямой парсинг, комменты и висячие запятые терпим.
  if (JSON_EXTENSIONS.has(ext)) return validateJsonContent(content);

  // XML-семейство — чистая well-formedness (компилятор не спавним).
  if (XML_EXTENSIONS.has(ext)) return validateXmlContent(content);

  // TypeScript — синтаксис через bun build.
  if (TS_EXTENSIONS.has(ext)) {
    return validateWithCompiler(
      filePath,
      ext,
      content,
      "bun",
      (tmpFile) => ["build", "--no-bundle", "--target=bun", tmpFile],
      "TypeScript syntax error",
      true,
    );
  }

  // JavaScript — синтаксис через node --check.
  if (JS_EXTENSIONS.has(ext)) {
    return validateWithCompiler(
      filePath,
      ext,
      content,
      "node",
      (tmpFile) => ["--check", tmpFile],
      "JavaScript syntax error",
      false,
    );
  }

  // Неподдерживаемое расширение — без валидации.
  return { valid: true };
}

/**
 * Проверка компилятором через временный файл (без шелла — путь от модели).
 * Общая для TypeScript (`bun build`) и JavaScript (`node --check`); результаты
 * кэшируются по хэшу контента.
 */
async function validateWithCompiler(
  filePath: string,
  ext: string,
  content: string,
  command: string,
  args: (tmpFile: string) => string[],
  fallbackError: string,
  useStdout: boolean,
): Promise<SyntaxValidationResult> {
  const hash = contentHash(content);
  const cached = SYNTAX_CACHE.get(filePath);
  if (cached && cached.hash === hash) {
    return cached.error ? { valid: false, error: cached.error } : { valid: true };
  }
  const tmpFile = `${filePath}.tmp${ext}`;
  try {
    writeFileSync(tmpFile, content, "utf-8");
    await runCommand(command, args(tmpFile), dirname(filePath), 5000);
    SYNTAX_CACHE.set(filePath, { hash, error: null });
    return { valid: true };
  } catch (err: any) {
    const stderr = err.stderr || (useStdout ? err.stdout || "" : "");
    const firstError =
      stderr.split("\n").find((line: string) => line.trim()) || fallbackError;
    const error = firstError.trim();
    SYNTAX_CACHE.set(filePath, { hash, error });
    return { valid: false, error };
  } finally {
    removeTempFile(tmpFile);
  }
}

/** Best-effort чистка временного файла: проверка уже вернулась, падения только
 * логируются ради диагностики, а не глотаются молча. */
function removeTempFile(tmpFile: string): void {
  try {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch (cleanupErr) {
    logger.warn(`failed to remove syntax-check temp file ${tmpFile}`, {
      error: String(cleanupErr),
    });
  }
}

/** JSON / JSONC — прямой парсинг, комменты и висячие запятые терпим. */
function validateJsonContent(content: string): SyntaxValidationResult {
  try {
    JSON.parse(content);
    return { valid: true };
  } catch (e: any) {
    try {
      JSON.parse(stripJsonComments(content));
      return { valid: true };
    } catch {
      return { valid: false, error: e.message };
    }
  }
}

/** XML-семейство — чистая well-formedness (компилятор не спавним). */
function validateXmlContent(content: string): SyntaxValidationResult {
  const error = checkXmlWellFormed(content);
  return error ? { valid: false, error } : { valid: true };
}

/**
 * Детект конфликтов import/export в TS/JS. Возвращает конфликтующие имена.
 */
export function detectImportConflicts(content: string): string[] {
  const conflicts: string[] = [];

  // Все именованные импорты: import { foo, bar as baz } from '...'.
  const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
  const exportRegex = /export\s+(?:function|class|const|let|var|type|interface|async\s+function)\s+(\w+)/g;

  const imports = new Set<string>();
  const exports = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content))) {
    const names = match[1]
      .split(",")
      .map((s) => s.trim())
      .map((s) => {
        // "foo as bar" — берём локальное имя (foo).
        const asMatch = s.match(/^(\w+)\s+as\s+\w+$/);
        return asMatch ? asMatch[1] : s;
      })
      .filter((s) => /^\w+$/.test(s));
    names.forEach((n) => imports.add(n));
  }

  while ((match = exportRegex.exec(content))) {
    exports.add(match[1]);
  }

  // Сверка конфликтов.
  for (const name of imports) {
    if (exports.has(name)) {
      conflicts.push(name);
    }
  }

  return conflicts;
}
