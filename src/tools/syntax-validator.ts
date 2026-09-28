import { writeFileSync, existsSync, unlinkSync } from "fs";
import { extname, dirname } from "path";
import { spawn } from "child_process";
import { Logger } from "../logger/app-logger";

const SYNTAX_CACHE = new Map<string, { hash: string; error: string | null }>();
const logger = new Logger("warn", "syntax-validator");

function contentHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return String(h);
}

/**
 * Run a compiler with timeout. Returns stdout/stderr on success, throws on
 * failure. Spawns WITHOUT a shell: the file path is model-supplied and shell
 * interpolation would execute `$()`/backticks/`%VAR%` in the filename.
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

/**
 * Supported file extensions for syntax validation.
 */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".cts", ".mts"]);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".cjs", ".mjs"]);
const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);
/** XML-family extensions: checked for well-formedness (no external deps). */
const XML_EXTENSIONS = new Set([".xml", ".drawio", ".svg", ".xaml", ".plist", ".iml"]);

/**
 * Minimal XML well-formedness check (no dependencies): a tag-stack scanner
 * that skips `<?...?>`, `<!--...-->`, `<![CDATA[...]]>` and `<!...>`
 * declarations, tracks quoted attribute spans (a `>` inside quotes never
 * closes a tag), and reports mismatched, unclosed, or stray closing tags.
 * Returns the first error, or null when the document is well-formed.
 * Observed gap: qwen3.5-9b wrote schema.drawio with a self-closed
 * `<diagram/>` followed by a stray `</diagram>` and claimed "valid".
 *
 * Split into small scanners so each unit stays under the complexity gate
 * (fallow pre-commit): comment/CDATA/PI spans, quote-aware `>` search,
 * open/close matching, and one markup step per `<`.
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

/** End index (past the closer) of a comment/CDATA/PI span, or -1 if open. */
function skipXmlSpan(content: string, i: number): { end: number; kind: XmlSpan["kind"] } | null {
  for (const s of XML_SPANS) {
    if (!content.startsWith(s.open, i)) continue;
    const end = content.indexOf(s.close, i + s.open.length);
    return end === -1 ? { end: -1, kind: s.kind } : { end: end + s.close.length, kind: s.kind };
  }
  return null;
}

/**
 * Index past the first `>` outside quotes, or -1. With trackBrackets (for
 * `<!...>` declarations with `[...]` sections) a `>` inside brackets is
 * skipped too.
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

/** Quote tracking for one scanned char: enter, exit, or keep the span. */
function nextQuoteState(quote: string | null, d: string): string | null {
  if (quote) return d === quote ? null : quote;
  return d === '"' || d === "'" ? d : null;
}

/** Raw inner text of a regular `<...>` tag plus the end index, or null. */
function readXmlTag(content: string, i: number): { raw: string; end: number } | null {
  const end = findClosingGt(content, i + 1, false);
  if (end === -1) return null;
  return { raw: content.slice(i + 1, end - 1).trim(), end };
}

function countLines(s: string): number {
  return s.split("\n").length - 1;
}

interface XmlScanState {
  content: string;
  i: number;
  line: number;
  stack: Array<{ name: string; line: number }>;
}

/** Advances past one `<...>` markup item. Returns an error (no line suffix) or null. */
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

/** Matches a closing tag against the stack. Returns an error or null. */
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

/** Matches an opening/self-closing tag against the stack. Returns an error or null. */
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
 * Matches one opening/self-closing/closing tag against the stack. Mutates
 * the stack, marks nothing else. Returns an error message (without line
 * suffix) or null.
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
 * Best-effort JSONC normalizer: strip `//` and `/* *\/` comments and trailing
 * commas so a valid commented `tsconfig.json` is not rejected as a syntax
 * error by the pre-write gate (which made small models strip needed comments).
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

export interface SyntaxValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Pre-validate file syntax BEFORE writing to disk.
 * Returns { valid: true } if syntax is OK or language is not supported.
 * Returns { valid: false, error: "..." } if syntax is invalid.
 *
 * For TypeScript/JavaScript: writes to a temp file and runs the compiler.
 * For JSON: parses the content directly.
 */
export async function preValidateSyntax(
  filePath: string,
  content: string,
  _baseDir: string,
): Promise<SyntaxValidationResult> {
  const ext = extname(filePath).toLowerCase();

  // JSON / JSONC — parse directly, tolerating comments and trailing commas.
  if (JSON_EXTENSIONS.has(ext)) return validateJsonContent(content);

  // XML family — pure well-formedness check (no compiler to spawn).
  if (XML_EXTENSIONS.has(ext)) return validateXmlContent(content);

  // TypeScript — syntax check via bun build
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

  // JavaScript — syntax check via node --check
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

  // Unsupported extension — skip validation
  return { valid: true };
}

/**
 * Runs a compiler syntax check via a temp file (no shell — the file path is
 * model-supplied). Shared by the TypeScript (`bun build`) and JavaScript
 * (`node --check`) branches; results are cached by content hash.
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

/** Best-effort temp-file cleanup: the check already returned, so failures
 * are only logged for diagnosability instead of silently ignored. */
function removeTempFile(tmpFile: string): void {
  try {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  } catch (cleanupErr) {
    logger.warn(`failed to remove syntax-check temp file ${tmpFile}`, {
      error: String(cleanupErr),
    });
  }
}

/** JSON / JSONC — parse directly, tolerating comments and trailing commas. */
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

/** XML family — pure well-formedness check (no compiler to spawn). */
function validateXmlContent(content: string): SyntaxValidationResult {
  const error = checkXmlWellFormed(content);
  return error ? { valid: false, error } : { valid: true };
}

/**
 * Detect import/export conflicts in TypeScript/JavaScript code.
 * Returns array of conflicting names.
 */
export function detectImportConflicts(content: string): string[] {
  const conflicts: string[] = [];

  // Extract all named imports: import { foo, bar as baz } from '...'
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
        // Handle "foo as bar" — take the local name (foo)
        const asMatch = s.match(/^(\w+)\s+as\s+\w+$/);
        return asMatch ? asMatch[1] : s;
      })
      .filter((s) => /^\w+$/.test(s));
    names.forEach((n) => imports.add(n));
  }

  while ((match = exportRegex.exec(content))) {
    exports.add(match[1]);
  }

  // Check for conflicts
  for (const name of imports) {
    if (exports.has(name)) {
      conflicts.push(name);
    }
  }

  return conflicts;
}
