import { renameSync, existsSync, mkdirSync } from "fs";
import { resolve, normalize, dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "./scope-check";
import { generateMoveDiff } from "../ui/diff";

export const moveFileTool: ToolDefinition = {
  name: "move_file",
  description: "Move or rename a file or directory.",
  tags: ["file"],
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Source path" },
      to: { type: "string", description: "Destination path" },
    },
    required: ["from", "to"],
  },
  handler: async (ctx, args) => {
    const fromPath = String(args.from);
    const toPath = String(args.to);
    const baseDir = resolve(ctx.baseDir);
    const fromResolved = resolve(baseDir, normalize(fromPath));
    const toResolved = resolve(baseDir, normalize(toPath));
    const fromCheck = isPathWritable(ctx.baseDir, fromPath, ctx.scope);
    const toCheck = isPathWritable(ctx.baseDir, toPath, ctx.scope);
    if (!fromCheck.allowed) {
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${fromPath} — ${fromCheck.reason}`,
        }),
      };
    }
    if (!toCheck.allowed) {
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${toPath} — ${toCheck.reason}`,
        }),
      };
    }
    if (!existsSync(fromResolved)) {
      return {
        success: false,
        output: t("file.not_found_short", { path: fromPath }),
      };
    }
    const toDir = dirname(toResolved);
    if (!existsSync(toDir)) {
      mkdirSync(toDir, { recursive: true });
    }
    renameSync(fromResolved, toResolved);
    const diff = generateMoveDiff(fromPath, toPath);
    return {
      success: true,
      output: t("file.moved", { from: fromPath, to: toPath }),
      diff,
    };
  },
};
