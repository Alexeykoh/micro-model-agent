/** Тул метаданных файла/каталога (размер, даты; кешируемый). */
import { statSync, existsSync } from "fs";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { safeResolvePath } from "./path-utils";

/** Возвращает JSON с размером, типом, датами создания/изменения. */
export const fileInfoTool: ToolDefinition = {
  name: "file_info",
  security: { caps: [{ fs: "read" }], pathArgs: ["path"] },
  icon: "ℹ️",
  description: "Get metadata about a file or directory (size, creation date, modification date).",
  tags: ["file"],
  boundedOutput: true,
  cacheable: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
    },
    required: ["path"],
  },
  handler: async (ctx, args) => {
    const path = String(args.path);
    const resolved = safeResolvePath(ctx.baseDir, path);

    if (!existsSync(resolved)) {
      return { success: false, output: t("file.not_found_short", { path }) };
    }
    const stat = statSync(resolved);
    return {
      success: true,
      output: JSON.stringify(
        {
          path,
          size: stat.size,
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          created: stat.birthtime,
          modified: stat.mtime,
        },
        null,
        2,
      ),
    };
  },
};
