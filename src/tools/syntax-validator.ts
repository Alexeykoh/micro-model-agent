import { writeFileSync, existsSync, unlinkSync } from "fs";
import { extname, dirname } from "path";
import { spawn } from "child_process";

const SYNTAX_CACHE = new Map<string, { hash: string; error: string | null }>();

function contentHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return String(h);
}

/**
 * Run a command with timeout. Returns stdout/stderr on success, throws on failure.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
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
const JSON_EXTENSIONS = new Set([".json"]);

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
  baseDir: string,
): Promise<SyntaxValidationResult> {
  const ext = extname(filePath).toLowerCase();

  // JSON — parse directly
  if (JSON_EXTENSIONS.has(ext)) {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }

  // TypeScript — syntax check via bun build
  if (TS_EXTENSIONS.has(ext)) {
    const hash = contentHash(content);
    const cached = SYNTAX_CACHE.get(filePath);
    if (cached && cached.hash === hash) {
      return cached.error ? { valid: false, error: cached.error } : { valid: true };
    }

    const tmpFile = `${filePath}.tmp${ext}`;
    try {
      writeFileSync(tmpFile, content, "utf-8");
      await runCommand(`bun build --no-bundle --target=bun "${tmpFile}"`, dirname(filePath), 5000);
      SYNTAX_CACHE.set(filePath, { hash, error: null });
      return { valid: true };
    } catch (err: any) {
      const stderr = err.stderr || err.stdout || "";
      const firstError =
        stderr.split("\n").find((line: string) => line.trim()) || "TypeScript syntax error";
      const error = firstError.trim();
      SYNTAX_CACHE.set(filePath, { hash, error });
      return { valid: false, error };
    } finally {
      try {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  // JavaScript — syntax check via node --check
  if (JS_EXTENSIONS.has(ext)) {
    const hash = contentHash(content);
    const cached = SYNTAX_CACHE.get(filePath);
    if (cached && cached.hash === hash) {
      return cached.error ? { valid: false, error: cached.error } : { valid: true };
    }

    const tmpFile = `${filePath}.tmp${ext}`;
    try {
      writeFileSync(tmpFile, content, "utf-8");
      await runCommand(`node --check "${tmpFile}"`, dirname(filePath), 5000);
      SYNTAX_CACHE.set(filePath, { hash, error: null });
      return { valid: true };
    } catch (err: any) {
      const stderr = err.stderr || "";
      const firstError =
        stderr.split("\n").find((line: string) => line.trim()) || "JavaScript syntax error";
      const error = firstError.trim();
      SYNTAX_CACHE.set(filePath, { hash, error });
      return { valid: false, error };
    } finally {
      try {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  // Unsupported extension — skip validation
  return { valid: true };
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

  let match;
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
