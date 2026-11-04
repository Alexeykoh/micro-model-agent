// Исполнение проверок lint-плагина: spawn с таймаутом/абортом, декодирование
// вывода дочернего процесса и память о проектах с неустановленным линтером.
import { spawn, execSync } from "child_process";
import { platform } from "os";
import { settleChildClose } from "../../../utils/child-run";

// Проекты, чей lint-скрипт ссылается на неустановленный бинарник
// (ключ baseDir::script). Сам прогон дорог, а маркер провала — чистый шум,
// поэтому пропускаем до конца процесса.
const missingLintBinaries = new Set<string>();

function lintCacheKey(baseDir: string, lintScript: string): string {
  return `${baseDir}::${lintScript}`;
}

/** Пропущен ли lint этого проекта из-за неустановленного бинарника. */
export function isLintBinaryMissing(baseDir: string, lintScript: string): boolean {
  return missingLintBinaries.has(lintCacheKey(baseDir, lintScript));
}

/** Запоминает проект с неустановленным бинарником линтера до конца процесса. */
export function markLintBinaryMissing(baseDir: string, lintScript: string): void {
  missingLintBinaries.add(lintCacheKey(baseDir, lintScript));
}

// Шелл-уровень "command not found" по локалям/рантаймам: POSIX `sh` пишет
// "command not found" (exit 127); Windows cmd.exe — "is not recognized"
// (en) / "не является внутренней или внешней командой" (ru), exit 1/9009.
const MISSING_BINARY_RE =
  /command not found|not recognized|не является внутренней|не распознан|не є внутрішньою|".+?" не является/i;

export function isMissingBinaryError(err: any, combinedOutput: string): boolean {
  // 127 = POSIX sh "command not found"; 9009 = Windows cmd.exe "is not
  // recognized" — оба авторитетны независимо от кодировки вывода.
  if (err.status === 127 || err.status === 9009) return true;
  if (err.code === "ENOENT") return true;
  return MISSING_BINARY_RE.test(combinedOutput);
}

let _winDecoder: TextDecoder | undefined;

/**
 * OEM-декодер активной консольной кодовой страницы (CP866 на русской Windows).
 * Зеркалит `getOemDecoder()` из modules/processes/registry.ts: транзиентный
 * провал chcp.com под нагрузкой НЕ кешируется — мемоизируется только успешный
 * проб (или жёсткий фолбэк ibm866).
 */
function getWinDecoder(): TextDecoder {
  if (_winDecoder !== undefined) return _winDecoder;
  if (platform() !== "win32") {
    _winDecoder = new TextDecoder("utf-8");
    return _winDecoder;
  }
  let decoder: TextDecoder | null = null;
  try {
    const cpOut = execSync("chcp.com", {
      encoding: "buffer",
      timeout: 2000,
      windowsHide: true,
    }).toString("latin1");
    const m = cpOut.match(/(\d+)/);
    if (m) decoder = new TextDecoder(`ibm${m[1]}`);
  } catch {
    /* chcp упал (нагрузка/ENOENT) — повторим при следующем вызове */
  }
  if (!decoder) {
    try {
      decoder = new TextDecoder("ibm866");
    } catch {
      return new TextDecoder("utf-8"); // неизвестная кодировка — не кешируем
    }
  }
  _winDecoder = decoder;
  return _winDecoder;
}

/**
 * Декодирует вывод дочернего процесса в UTF-8. Современные тулы (bun, node,
 * npm, tsc) пишут UTF-8 в пайп; встроенные команды/ошибки cmd.exe — OEM-страницу.
 * Сначала строгий UTF-8; на невалидных байтах — откат на OEM.
 */
function decodeOutput(chunks: Buffer[]): string {
  const raw = Buffer.concat(chunks);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    /* невалидный UTF-8 → вывод в OEM-кодировке */
  }
  try {
    return getWinDecoder().decode(raw);
  } catch {
    return raw.toString("latin1");
  }
}

/**
 * Гоняет команду асинхронно (не стопая event loop) и резолвится на выходе.
 * Реджектит с захваченными stderr/stdout при ненулевом коде или таймауте.
 *
 * Простая строка идёт через шелл (проектные скрипты). Спецификация
 * `{file,args}` спавнится БЕЗ шелла — обязательно для всего, собранного из
 * модельного пути (`bun build … <file>`, `node --check <file>`): в имени могут
 * быть `$()`, бектики или `%VAR%`, а shell:true их исполнил бы (инъекция).
 */
export function runAsync(
  command: string | { file: string; args: string[] },
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child =
      typeof command === "string"
        ? spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(command.file, command.args, {
            cwd,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
    const utf8Chunks: Buffer[] = [];
    const oemChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => {
      utf8Chunks.push(Buffer.from(d));
    });
    child.stderr?.on("data", (d: Buffer) => {
      oemChunks.push(Buffer.from(d));
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Прерывание (Esc/Ctrl+C): убиваем ребёнка, чтобы петля агента сразу
    // вернулась в промпт, а не высиживала длинный tsc/lint. Хендлер close
    // при аборте резолвит пусто — гард `signal.aborted` вызывающего результат
    // всё равно отбрасывает.
    const onAbort = () => child.kill();
    if (signal?.aborted) {
      child.kill();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        resolve({ stdout: decodeOutput(utf8Chunks), stderr: decodeOutput(oemChunks) });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = decodeOutput(utf8Chunks);
      const stderr = decodeOutput(oemChunks);
      if (signal?.aborted) {
        resolve({ stdout, stderr });
        return;
      }
      settleChildClose(code, stdout, stderr, `Command failed with exit code ${code}`, resolve, reject);
    });
  });
}
