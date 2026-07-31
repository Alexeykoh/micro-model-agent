import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { resolve, normalize, dirname } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { isPathWritable } from "./scope-check";
import { generateDiff, generateNewFileDiff } from "../ui/diff";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Create or overwrite a file with given content. Creates intermediate directories if needed.",
  tags: ["file", "code"],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      content: { type: "string", description: "File content" },
    },
    required: ["path", "content"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const baseDir = resolve(ctx.baseDir);
    const resolved = resolve(baseDir, normalize(path));
    const scopeCheck = isPathWritable(ctx.baseDir, path, ctx.scope);
    if (!scopeCheck.allowed) {
      return {
        success: false,
        output: t("file.path_not_allowed", {
          path: `${path} — ${scopeCheck.reason}`,
        }),
      };
    }
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const fileExists = existsSync(resolved);
    let oldContent = "";
    if (fileExists) {
      oldContent = readFileSync(resolved, "utf-8");
    }
    const newContent = String(args.content);
    writeFileSync(resolved, newContent, "utf-8");
    const diff = fileExists
      ? generateDiff(oldContent, newContent)
      : generateNewFileDiff(newContent);
    ctx.trackCreatedPath?.(path);
    return { success: true, output: t("file.written", { path }), diff };
  },
};
