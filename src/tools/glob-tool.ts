/** Тул поиска файлов по glob-паттерну (кешируемый, jail в baseDir). */
import { globSync } from "fs";
import { resolve } from "path";
import { t } from "../i18n/index";
import type { ToolDefinition } from "./types";
import { MAX_PREVIEW_LINES } from "./preview";
import { isPathInScope } from "../modules/security/path-validator";
import { matchesAnyGlob } from "../modules/security/path-glob";
import { matchProtectedPath } from "../modules/security/protected-paths";

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

    // Скоуп субагента, denied-паттерны и защищённые пути не показываем
    // (аудит §4.5): выдача списка — тоже раскрытие путей.
    const pathsCfg = ctx.config?.security?.paths;
    const denied = pathsCfg?.denied ?? [];
    const visible: string[] = [];
    let hidden = 0;
    for (const match of results) {
      const abs = resolve(ctx.baseDir, match);
      const outOfScope =
        ctx.scope !== undefined &&
        !isPathInScope(ctx.baseDir, abs, ctx.scope, pathsCfg).allowed;
      const isDenied = denied.length > 0 && matchesAnyGlob(abs, ctx.baseDir, denied);
      const isProtected = matchProtectedPath(ctx.baseDir, abs) !== undefined;
      if (outOfScope || isDenied || isProtected) {
        hidden++;
        continue;
      }
      visible.push(match);
    }

    if (visible.length === 0) {
      return { success: true, output: t("file.no_matches") };
    }
    const truncated =
      visible.length > MAX_PREVIEW_LINES
        ? `\n... (${visible.length - MAX_PREVIEW_LINES} more files)`
        : "";
    const hiddenNote = hidden > 0 ? `\n${t("file.glob_hidden", { count: String(hidden) })}` : "";
    return {
      success: true,
      output: visible.slice(0, MAX_PREVIEW_LINES).join("\n") + truncated + hiddenNote,
    };
  },
};
