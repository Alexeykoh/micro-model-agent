/** Превалидация синтаксиса перед записью (TS/JS/JSON/XML), без шелла. */
import { writeFileSync, existsSync, unlinkSync } from "fs";
import { extname, dirname } from "path";
import { spawn } from "child_process";
import { Logger } from "../logger/app-logger";
import { settleChildClose } from "../utils/child-run";
import { validateXmlContent } from "./syntax-xml";

export { checkXmlWellFormed } from "./syntax-xml";

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
      settleChildClose(code, stdout, stderr, `Syntax check failed with exit code ${code}`, resolve, reject);
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
