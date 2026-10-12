/** Тул поиска файлов по glob-паттерну (кешируемый, jail в baseDir). */
import { globSync } from "fs";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { MAX_PREVIEW_LINES } from "./preview";

/** Ищет файлы по glob; выдача обрезана MAX_PREVIEW_LINES. */
export const globTool: ToolDefinition = {
  name: "glob",
  security: { caps: [{ fs: "read" }] },
  icon: "🔎",
  description: `Search for files matching a glob pattern. Shows up to ${MAX_PREVIEW_LINES} results by default. Uses standard glob syntax (e.g., **/*.ts, src/**/*.test.ts).`,
  tags: ["file", "code", "research"],
  cacheable: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
    },
    required: ["pattern"],
  },
  handler: async (ctx, args) => {
    const pattern = String(args.pattern);
    // Абсолютные паттерны (/etc/*) и ".." выводят за baseDir — запретить.
    if (/^([a-zA-Z]:)?[\\/]/.test(pattern) || pattern.split(/[\\/]/).includes("..")) {
      return {
        success: false,
        output: t("file.path_not_allowed", { path: pattern }),
      };
    }
    const results = globSync(pattern, { cwd: ctx.baseDir });
    if (results.length === 0) {
      return { success: true, output: t("file.no_matches") };
    }
    const truncated =
      results.length > MAX_PREVIEW_LINES
        ? `\n... (${results.length - MAX_PREVIEW_LINES} more files)`
        : "";
    return { success: true, output: results.slice(0, MAX_PREVIEW_LINES).join("\n") + truncated };
  },
};
