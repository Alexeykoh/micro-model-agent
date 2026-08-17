import { readFileSync, existsSync } from "fs";
import { resolve, extname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathInScope } from "../modules/security/path-validator";
import { DEFAULT_SECURITY_CONFIG } from "../config/security";
import { logSecurityBlock } from "../modules/security/audit-log";
import { safeResolvePath } from "./path-utils";

/**
 * Default lines per read_file call. Deliberately much larger than
 * MAX_PREVIEW_LINES (15): a 15-line default forces the model to issue 10-17
 * calls per file, which floods the context and drives compaction every 15
 * iterations (observed: 96 read_file calls, App.tsx read 23x, then 11
 * compactions in ~20 min that deleted the user's task mid-turn). 300 lines
 * covers typical component files in one call while still capping output.
 */
const DEFAULT_LIMIT = 300;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: `Read a file from the filesystem. Reads up to ${DEFAULT_LIMIT} lines at a time by default; use offset to page through large files.`,
  tags: ["file", "code"],
  boundedOutput: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
      offset: {
        type: "number",
        description: `Starting line (1-indexed). Use offset=<next> from a truncated result to continue reading.`,
      },
      limit: {
        type: "number",
        description: `Number of lines to read (default ${DEFAULT_LIMIT})`,
      },
    },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);
    const securityPaths = ctx.config?.security?.paths || DEFAULT_SECURITY_CONFIG.paths;
    const scopeCheck = isPathInScope(ctx.baseDir, resolved, ctx.scope, securityPaths);

    if (!scopeCheck.allowed) {
      const pathStr = path as string;
      logSecurityBlock(
        ctx.sessionId || undefined,
        "file_read",
        scopeCheck.reason || "Path not allowed",
        pathStr,
      );
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }
    if (!existsSync(resolved)) {
      // For relative paths, tell the model WHERE the path resolved — the
      // "not found" alone is confusing (it cannot tell baseDir from cwd).
      const output =
        resolved !== path
          ? t("file.notfound_resolved", {
              path,
              resolved,
            })
          : t("file.notfound", { path });
      return { success: false, output };
    }
    const content = readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    const total = lines.length;
    const offset = (args.offset as number) || 1;
    const limit = (args.limit as number) || DEFAULT_LIMIT;
    const end = Math.min(offset - 1 + limit, total);
    const selected = lines.slice(offset - 1, end).join("\n");
    const ext = extname(resolved) || "(no extension)";
    const header = t("file.read_header", {
      path,
      ext,
      total: String(total),
      from: String(offset),
      to: String(end),
    });
    const truncated =
      end < total
        ? t("file.read_truncated", {
            remaining: String(total - end),
            next: String(end + 1),
          })
        : "";
    const display = truncated ? `${header}${truncated}` : header;
    return {
      success: true,
      output: `${header}\n${selected}${truncated}`,
      display,
    };
  },
};
