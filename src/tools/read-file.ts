import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
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

/**
 * Files larger than this are read through a bounded streaming path instead of
 * readFileSync (which loads the whole file into memory just to slice a few
 * hundred lines).
 */
const LARGE_FILE_BYTES = 1024 * 1024;
const STREAM_CHUNK = 256 * 1024;

/**
 * Bounded line-slice read for large files: streams the file in chunks,
 * collects only the requested [offset, offset+limit) window, then counts the
 * remaining newlines raw (no decode) to produce the total. Memory stays
 * bounded regardless of file size.
 */
function readLineSlice(
  path: string,
  offset: number,
  limit: number,
): { selected: string; total: number } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(STREAM_CHUNK);
    let pos = 0;
    let carry = "";
    let lineNumber = 1;
    let total = 0;
    const collected: string[] = [];
    const endLine = offset + limit; // exclusive

    while (true) {
      const bytes = readSync(fd, buf, 0, STREAM_CHUNK, pos);
      if (bytes === 0) break;
      pos += bytes;
      const chunk = carry + buf.toString("utf-8", 0, bytes);
      const parts = chunk.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) {
        total++;
        if (lineNumber >= offset && lineNumber < endLine) collected.push(line);
        lineNumber++;
      }
      if (lineNumber >= endLine && collected.length >= limit) {
        // Window complete — count remaining newlines without decoding.
        const rest: Buffer[] = [];
        while (true) {
          const n = readSync(fd, buf, 0, STREAM_CHUNK, pos);
          if (n === 0) break;
          pos += n;
          rest.push(Buffer.from(buf.subarray(0, n)));
        }
        const tail = Buffer.concat([...rest, Buffer.from(carry, "utf-8")]);
        for (let i = 0; i < tail.length; i++) if (tail[i] === 0x0a) total++;
        total++; // last line has no trailing newline
        return { selected: collected.join("\n"), total };
      }
    }
    if (carry.length > 0 || total === 0) {
      total++;
      if (lineNumber >= offset && lineNumber < endLine) collected.push(carry);
    }
    return { selected: collected.join("\n"), total };
  } finally {
    closeSync(fd);
  }
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  icon: "👀",
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
    const offset = (args.offset as number) || 1;
    const limit = (args.limit as number) || DEFAULT_LIMIT;

    let lines: string[];
    let total: number;
    let selected: string;
    if (statSync(resolved).size > LARGE_FILE_BYTES) {
      const slice = readLineSlice(resolved, offset, limit);
      total = slice.total;
      selected = slice.selected;
    } else {
      const content = readFileSync(resolved, "utf-8");
      lines = content.split("\n");
      total = lines.length;
      const end = Math.min(offset - 1 + limit, total);
      selected = lines.slice(offset - 1, end).join("\n");
    }
    const end = Math.min(offset - 1 + limit, total);
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
    // Compact user-facing display: the tool header already shows the path,
    // so only a partial read needs extra info (the range within the file).
    // A full read adds nothing — keeps the card to two lines.
    const fullRead = offset === 1 && end >= total;
    const display = fullRead
      ? ""
      : t("file.read_range", {
          from: String(offset),
          to: String(end),
          total: String(total),
        });
    return {
      success: true,
      output: `${header}\n${selected}${truncated}`,
      display,
    };
  },
};
