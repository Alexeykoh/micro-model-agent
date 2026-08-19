import { execFileSync } from "child_process";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { logBashCommand } from "../modules/security/audit-log";
import { MAX_PREVIEW_LINES } from "./preview";

function truncateLines(output: string): string {
  const lines = output.split("\n");
  if (lines.length <= MAX_PREVIEW_LINES) return output;
  return (
    lines.slice(0, MAX_PREVIEW_LINES).join("\n") +
    `\n... (${lines.length - MAX_PREVIEW_LINES} more lines)`
  );
}

export const grepTool: ToolDefinition = {
  name: "grep",
  icon: "🔍",
  description: `Search file contents using a regular expression. Shows up to ${MAX_PREVIEW_LINES} matching lines by default. Uses ripgrep (rg) if available, otherwise falls back to grep -r.`,
  tags: ["file", "code", "research"],
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

    // Build rg arguments as an array to avoid shell interpretation of regex
    // metacharacters like |, (, ) — these are regex patterns, not shell operators.
    const rgArgs = ["-n", "--with-filename", pattern, searchPath];
    if (args.include) {
      rgArgs.push("-g", String(args.include));
    }

    // Log the search (sanitized) for audit purposes
    logBashCommand(ctx.sessionId, `rg ${rgArgs.join(" ")}`, false, "grep-tool");

    try {
      const output = execFileSync("rg", rgArgs, {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        cwd: ctx.baseDir,
      });
      return {
        success: true,
        output: truncateLines(output || t("file.no_matches")),
      };
    } catch (e: any) {
      if (e.status === 1) return { success: true, output: t("file.no_matches") };
      // Fall back to plain grep -r when rg is not available or fails.
      // Using execFileSync with array args avoids shell injection.
      try {
        const grepArgs = ["-rn", pattern, searchPath];
        if (args.include) {
          grepArgs.push("--include", String(args.include));
        }
        const output = execFileSync("grep", grepArgs, {
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
          cwd: ctx.baseDir,
        });
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
