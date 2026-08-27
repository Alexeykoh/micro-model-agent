import { readdirSync, statSync, existsSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathInScope } from "../modules/security/path-validator";
import { safeResolvePath } from "./path-utils";
import { MAX_PREVIEW_LINES } from "./preview";

/** Directories hidden from list_dir output (consistent with indexer walker). */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".mma"]);

export const listDirTool: ToolDefinition = {
  name: "list_dir",
  icon: "📂",
  description: `List files and directories in a given path. Shows up to ${MAX_PREVIEW_LINES} entries by default.`,
  tags: ["file"],
  boundedOutput: true,
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

    // Check path permissions
    const scopeCheck = isPathInScope(ctx.baseDir, resolved, ctx.scope, ctx.config.security?.paths);
    if (!scopeCheck.allowed) {
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }

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
