// Синтаксис-проверка записанного файла (bun build / node --check) с кешем по
// хешу содержимого. Вынесено из `lint-on-write.ts` (правило 6: ≤300 строк).
import { readFileSync } from "fs";
import { childErr, runAsync } from "./lint-run";

/**
 * Исполняемый Bun для `bun build`. Под самим Bun — `process.execPath`: на
 * Windows, где `bun` стоит npm-шимом (`bun.ps1`/`bun.cmd`), `spawn("bun")` не
 * находит файл, и проверка синтаксиса молча пропускалась (`ENOENT` → null).
 */
function bunExecutable(): string {
  return process.versions.bun ? process.execPath : "bun";
}

// Пофайловые синтаксис-проверки кешируются по (путь, хеш содержимого): перезапись
// файла с тем же содержимым скипает (дорогую) проверку. Смена контента →
// промах кеша → свежая проверка.
const syntaxCache = new Map<string, { hash: string; error: string | null }>();

function contentHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  }
  return String(h);
}

/** Синтаксис файла: текст ошибки или null (в т.ч. когда проверить нечем). */
export async function checkSyntax(
  filePath: string,
  ext: string,
  baseDir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (ext === ".ts" || ext === ".tsx" || ext === ".cts" || ext === ".mts") {
    // Проверка только синтаксиса парсером bun (~200мс) вместо `npx tsc`
    // (~3-5с на запись). Полные ошибки типов всё равно отдаёт дебаунснутый
    // проектный typecheck, когда есть tsconfig.
    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
    const hash = contentHash(content);
    const cached = syntaxCache.get(filePath);
    if (cached && cached.hash === hash) {
      return cached.error;
    }
    try {
      await runAsync(
        { file: bunExecutable(), args: ["build", "--no-bundle", "--target=bun", filePath] },
        baseDir,
        10000,
        signal,
      );
      // Прерванная проверка (interrupt) файл не валидировала — не кешируем.
      if (signal?.aborted) return null;
      syntaxCache.set(filePath, { hash, error: null });
      return null;
    } catch (rawErr: unknown) {
      const err = childErr(rawErr);
      if (
        err.status === 127 ||
        err.message.includes("not found") ||
        err.message.includes("ENOENT")
      ) {
        return null;
      }
      const stderr = String(err.stderr ?? "") || String(err.stdout ?? "");
      const firstError =
        stderr.split("\n").find((line: string) => line.trim()) || "TypeScript syntax error";
      syntaxCache.set(filePath, { hash, error: firstError.trim() });
      return firstError.trim();
    }
  }

  if (ext === ".js" || ext === ".jsx" || ext === ".cjs" || ext === ".mjs") {
    try {
      await runAsync({ file: "node", args: ["--check", filePath] }, baseDir, 5000, signal);
      return null;
    } catch (rawErr: unknown) {
      const err = childErr(rawErr);
      const stderr = String(err.stderr ?? "");
      const firstError =
        stderr.split("\n").find((line: string) => line.trim()) || "JavaScript syntax error";
      return firstError.trim();
    }
  }

  return null;
}
