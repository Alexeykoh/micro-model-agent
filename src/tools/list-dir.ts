/** Тул листинга каталога (игнор мусора, cap вывода, кешируемый). */
import { readdirSync, statSync, existsSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { safeResolvePath } from "./path-utils";
import { MAX_PREVIEW_LINES } from "./preview";

/** Каталоги вне выдачи list_dir (едино с walker'ом индексёра). */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".mma"]);

/** Показывает файлы/подкаталоги (каталоги с `/`); мусор скрыт. */
export const listDirTool: ToolDefinition = {
  name: "list_dir",
  security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
  icon: "📂",
  description: `List files and directories in a given path. Shows up to ${MAX_PREVIEW_LINES} entries by default.`,
  tags: ["file"],
  boundedOutput: true,
  cacheable: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
    },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);

    if (!existsSync(resolved)) {
      return { success: false, output: t("file.dir_notfound", { path }) };
    }
    const entries = readdirSync(resolved).filter((e) => !IGNORED_DIRS.has(e));
    const lines = entries.map((e) => {
      const full = resolve(resolved, e);
      return statSync(full).isDirectory() ? `${e}/` : e;
    });
    if (lines.length === 0) {
      return { success: true, output: t("file.empty") };
    }
    const truncated =
      lines.length > MAX_PREVIEW_LINES
        ? `\n... (${lines.length - MAX_PREVIEW_LINES} more entries)`
        : "";
    return { success: true, output: lines.slice(0, MAX_PREVIEW_LINES).join("\n") + truncated };
  },
};
