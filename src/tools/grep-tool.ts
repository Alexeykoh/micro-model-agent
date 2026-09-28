/** Тул поиска по содержимому (rg с fallback на grep -r). */
import { spawn, } from "child_process";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { logBashCommand, logSecurityBlock } from "../modules/security/audit-log";
import { isPathInScope } from "../modules/security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { MAX_PREVIEW_LINES } from "./preview";

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
        reject(new Error(err || `exit ${code}`));
      }
    });
  });
}

/** Ищет по содержимому через regex (rg, иначе grep -r); кешируемый. */
export const grepTool: ToolDefinition = {
  name: "grep",
  icon: "🔍",
  description: `Search file contents using a regular expression. Shows up to ${MAX_PREVIEW_LINES} matching lines by default. Uses ripgrep (rg) if available, otherwise falls back to grep -r.`,
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

    // Каталог поиска обязан оставаться внутри baseDir/скоупа: `path: "../../.."`
    // не должен читать вне песочницы.
    const scopeCheck = isPathInScope(
      ctx.baseDir,
      searchPath,
      ctx.scope,
      ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths,
    );
    if (!scopeCheck.allowed) {
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
      };
    }

    // Аргументы rg массивом, чтобы шелл не трактовал метасимволы regex
    // (|, (, )) как операторы — это паттерны, не команды шелла.
    const rgArgs = ["-n", "--with-filename", pattern, searchPath];
    if (args.include) {
      rgArgs.push("-g", String(args.include));
    }

    logBashCommand(ctx.sessionId, `rg ${rgArgs.join(" ")}`, false, "grep-tool");

    try {
      const output = await runSearch("rg", rgArgs, ctx.baseDir);
      return {
        success: true,
        output: truncateLines(output || t("file.no_matches")),
      };
    } catch (e: any) {
      if (e.code === "ENOENT") {
        // fall through to grep fallback
      } else if (/timed out/.test(e.message)) {
        return { success: false, output: t("error.grep_failed", { message: e.message }) };
      } else if (e.status === 1) {
        return { success: true, output: t("file.no_matches") };
      }
      // Fallback на plain grep -r, когда rg нет или упал. Массив аргументов —
      // защита от shell injection.
      try {
        const grepArgs = ["-rn", pattern, searchPath];
        if (args.include) {
          grepArgs.push("--include", String(args.include));
        }
        const output = await runSearch("grep", grepArgs, ctx.baseDir);
        return {
          success: true,
          output: truncateLines(output || t("file.no_matches")),
        };
      } catch (e2: any) {
        if (e2.status === 1) return { success: true, output: t("file.no_matches") };
        return {
          success: false,
          output: t("error.grep_failed", { message: e2.message }),
        };
      }
    }
  },
};
