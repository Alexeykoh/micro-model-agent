/** Тул поиска по содержимому (rg с fallback на grep -r). */
import { spawn, } from "child_process";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition, ToolResult } from "./types";
import { logBashCommand, logSecurityBlock } from "../modules/security/audit-log";
import { isPathInScope } from "../modules/security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { MAX_PREVIEW_LINES } from "./preview";
import { searchWithJs } from "./grep-js";

/** Обрезает вывод до MAX_PREVIEW_LINES строк. */
function truncateLines(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= MAX_PREVIEW_LINES) return output;
  return (
    lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
    `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
  );
}

/**
 * Поисковая команда асинхронно, с kill по таймауту. Exit code 1 (нет совпадений)
 * резолвится в пустую строку. Возврат: stdout поиска.
 */
export function runSearch(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`search timed out after ${timeoutMs}ms`));
      } else if (code === 1) {
        resolvePromise("");
      } else if (code === 0) {
        resolvePromise(out);
      } else {
        reject(Object.assign(new Error(err || `exit ${code}`), { status: code }));
      }
    });
  });
}

/**
 * Классифицирует ошибку внешнего поиска: результат или null (движок недоступен,
 * вызывающий пробует следующий / JS-фолбэк).
 *
 * `e.status === 1` (нет совпадений) сюда практически не долетает: `runSearch`
 * сам резолвит пустую строку на exit code 1. Ветку оставляем для вызывающих,
 * которые могут прийти с готовым процессным статусом.
 */
export function classifySearchError(e: any): ToolResult | null {
  const msg = String(e?.message ?? "");
  if (/timed out/.test(msg)) {
    return { success: false, output: t("error.grep_failed", { message: msg }) };
  }
  if (e?.status === 1) return { success: true, output: t("file.no_matches") };
  if (e?.code === "ENOENT") return null;
  // Шелл-ошибка шима (npm `.cmd`/`.ps1` под Bun идёт через cmd.exe): внешний
  // движок фактически недоступен — не роняем поиск, падаем на JS-движок.
  // `status` 255/9009 — cmd.exe «команда не найдена» через шим, независимо от
  // локали; текстовая проверка страхует англоязычные сборки/execFileSync.
  if (e?.status === 255 || e?.status === 9009) return null;
  if (/is not recognized|command not found/i.test(msg)) return null;
  return { success: false, output: t("error.grep_failed", { message: msg }) };
}

/**
 * Запускает один внешний движок. Возвращает null, если бинаря нет (ENOENT) —
 * тогда вызывающий пробует следующий.
 */
async function runExternalEngine(
  bin: "rg" | "grep",
  argv: string[],
  ctx: { baseDir: string; sessionId?: string },
): Promise<ToolResult | null> {
  logBashCommand(ctx.sessionId, `${bin} ${argv.join(" ")}`, false, "grep-tool");
  try {
    const output = await runSearch(bin, argv, ctx.baseDir);
    return { success: true, output: truncateLines(output || t("file.no_matches")) };
  } catch (e: any) {
    return classifySearchError(e);
  }
}

/** Собирает argv внешних движков (rg/grep) с опциональным include. */
function buildSearchArgs(
  pattern: string,
  searchPath: string,
  include: string | undefined,
): { rgArgs: string[]; grepArgs: string[] } {
  // Массивы аргументов: шелл не трактует метасимволы regex как операторы.
  const rgArgs = ["-n", "--with-filename", pattern, searchPath];
  const grepArgs = ["-rn", pattern, searchPath];
  if (include) {
    rgArgs.push("-g", include);
    grepArgs.push("--include", include);
  }
  return { rgArgs, grepArgs };
}

/** Встроенный JS-поиск как финальный фолбэк. */
function runJsEngine(
  ctx: any,
  pattern: string,
  searchPath: string,
  include: string | undefined,
): ToolResult {
  try {
    const output = searchWithJs(pattern, searchPath, ctx.baseDir, {
      include,
      maxFiles: ctx.config?.indexer?.maxFiles,
    });
    return { success: true, output: truncateLines(output || t("file.no_matches")) };
  } catch (e: any) {
    return { success: false, output: t("error.grep_failed", { message: e?.message }) };
  }
}

/** Оркестрация движков: rg → grep → встроенный JS (или принудительно один). */
async function runGrepEngines(
  ctx: any,
  pattern: string,
  searchPath: string,
  include: string | undefined,
  engine: "auto" | "rg" | "grep" | "js",
): Promise<ToolResult> {
  const { rgArgs, grepArgs } = buildSearchArgs(pattern, searchPath, include);
  const engines = new Set(engine === "auto" ? ["rg", "grep", "js"] : [engine]);
  if (engines.has("rg")) {
    const r = await runExternalEngine("rg", rgArgs, ctx);
    if (r) return r;
  }
  if (engines.has("grep")) {
    const r = await runExternalEngine("grep", grepArgs, ctx);
    if (r) return r;
  }
  if (engines.has("js")) return runJsEngine(ctx, pattern, searchPath, include);
  // Движок задан явно и недоступен — actionable-ошибка вместо ENOENT.
  return {
    success: false,
    output: t("error.grep_no_engine", { engine }),
    errorMeta: { code: "grep_no_engine", retryable: true, hint: "set tools.grepEngine=auto or js" },
  };
}

/**
 * Проверяет, что каталог поиска внутри baseDir/скоупа (`path: "../../.."` не
 * должен читать вне песочницы). Возвращает отказ или null, если можно искать.
 */
function checkGrepScope(
  ctx: any,
  args: Record<string, unknown>,
  searchPath: string,
): ToolResult | null {
  const scopeCheck = isPathInScope(
    ctx.baseDir,
    searchPath,
    ctx.scope,
    ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths,
  );
  if (scopeCheck.allowed) return null;
  logSecurityBlock(
    ctx.sessionId || undefined,
    "file_read",
    scopeCheck.reason || "grep path not allowed",
    String(args.path ?? ctx.baseDir),
  );
  return {
    success: false,
    output: t("file.path_not_allowed", {
      path: `${args.path ?? "."} — ${scopeCheck.reason}`,
    }),
    errorMeta: { code: "path_not_allowed", retryable: false, hint: "search inside the project root" },
  };
}

/** Ищет по содержимому через regex (rg → grep → zero-dep JS); кешируемый. */
export const grepTool: ToolDefinition = {
  name: "grep",
  icon: "🔍",
  description: `Search file contents using a regular expression. Shows up to ${MAX_PREVIEW_LINES} matching lines by default. Uses ripgrep (rg) or grep when available, otherwise a built-in JS walker (no external binary needed).`,
  tags: ["file", "code", "research"],
  cacheable: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search" },
      include: {
        type: "string",
        description: "File pattern to filter (e.g. *.ts)",
      },
      path: {
        type: "string",
        description: "Directory to search (defaults to baseDir)",
      },
    },
    required: ["pattern"],
  },
  handler: async (ctx, args) => {
    const pattern = String(args.pattern);
    const searchPath = args.path ? resolve(ctx.baseDir, String(args.path)) : ctx.baseDir;
    const denied = checkGrepScope(ctx, args, searchPath);
    if (denied) return denied;
    const engine = ctx.config?.tools?.grepEngine ?? "auto";
    return runGrepEngines(
      ctx,
      pattern,
      searchPath,
      args.include ? String(args.include) : undefined,
      engine,
    );
  },
};
