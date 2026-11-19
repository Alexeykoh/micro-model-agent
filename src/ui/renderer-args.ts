// Аргументы тулов → человекочитаемые строки (шов `renderer.ts`, правило 6).
import { isAbsolute, relative, sep } from "path";
import { t } from "../i18n/index";
import { glyph } from "./theme";

/** Тулы, чей аргумент `path` показывается в шапке. */
const PATH_TOOLS = new Set([
  "read_file", "write_file", "append_file",
  "edit_file",
  "delete_file",
  "create_dir",
  "move_file",
  "list_dir",
  "file_info",
]);

export function isPathTool(tool: string): boolean {
  return PATH_TOOLS.has(tool);
}

export function toDisplayPath(baseDir: string | undefined, p: string): string {
  if (!baseDir || !isAbsolute(p)) return p;
  const rel = relative(baseDir, p);
  // Вне baseDir (префикс ../) или другой диск (абсолютный результат) — как есть.
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel.split(sep).join("/");
}

/**
 * Ведущий маркер каждого действия. В стиле один маркер (`◇`) на все тулы:
 * категории передаются локализованным ярлыком, а не глифом.
 */
export function toolMarker(_tool: string): string {
  return glyph.action;
}

/** Короткая человекочитаемая сводка аргументов тула. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const preferred = ["path", "file", "query", "url", "command", "name"];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === "string" && value) {
      return value.length > 60 ? `${value.slice(0, 57)}…` : value;
    }
  }
  const serialized = JSON.stringify(args);
  if (!serialized || serialized === "{}") return "";
  return serialized.length > 60 ? `${serialized.slice(0, 57)}…` : serialized;
}

/** Скалярные ключи, показываемые как есть, в порядке приоритета, для обычных тулов. */
const GENERIC_ARG_KEYS = [
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "command",
  "name",
  "task",
  "level",
  "id",
  "source",
  "step",
  "key",
  "value",
  "text",
];

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function truncateArg(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/**
 * Человекочитаемая сводка аргументов. Структурные тулы несут сырой JSON,
 * который потёк бы в чат, — им короткая локализованная фраза.
 */
export function humanArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === "plan") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "update") {
      const step = args.step ?? args.stepId;
      const status = args.status;
      if (step !== undefined || status !== undefined) {
        return t("ui.plan_update", {
          step: String(step ?? "?"),
          status: String(status ?? "?"),
        });
      }
    }
    if (action === "create" && typeof args.title === "string") return args.title;
    if (action) return action;
  }
  if (tool === "plan_step") {
    const step = args.step;
    const status = args.status;
    if (step !== undefined || status !== undefined) {
      return t("ui.plan_update", {
        step: String(step ?? "?"),
        status: String(status ?? "?"),
      });
    }
  }
  if (tool === "todo") {
    const action = typeof args.action === "string" ? args.action : "";
    const items = Array.isArray(args.items) ? args.items.length : undefined;
    if (action && items !== undefined) return t("ui.todo_action", { action, count: String(items) });
    if (action) return action;
  }
  // Обычные экшен-тулы (browser, project_map, lsp_check, …) несут `action` плюс
  // пару коротких скаляров — рендерим фразу, а не сырой JSON.
  if (typeof args.action === "string" && args.action) {
    const extras = ["direction", "selector", "key", "name", "path", "url", "query", "text", "id"]
      .map((k) => (typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined))
      .filter((v): v is string => Boolean(v));
    return truncateArg([args.action, ...extras].join(" "));
  }
  // Композиты, где один ключ уронил бы половину смысла.
  if (tool === "move_file") {
    const from = str(args.from);
    const to = str(args.to);
    if (from && to) return truncateArg(`${from} → ${to}`);
  }
  if (tool === "mcp_call") {
    const server = str(args.server);
    const name = str(args.tool);
    if (server && name) return `${server}/${name}`;
  }
  if (tool === "remember") {
    const category = str(args.category);
    const key = str(args.key);
    const entry = str(args.entry);
    const body = key && args.value !== undefined ? `${key} = ${str(args.value)}` : key || entry;
    const phrase = [category, body].filter(Boolean).join(" · ");
    if (phrase) return truncateArg(phrase);
  }
  if (tool === "enable_tools") {
    const tags = Array.isArray(args.tags) ? args.tags.map(String).filter(Boolean) : [];
    if (tags.length) return tags.join(", ");
  }
  for (const key of GENERIC_ARG_KEYS) {
    const value = str(args[key]);
    if (value) return truncateArg(value);
  }
  return summarizeArgs(args);
}

/**
 * Локализованный человеческий ярлык тула. Системные имена (`read_file`, `bash`, …)
 * НЕ показываются юзеру — см. `docs/design/ui/STYLE.md`.
 */
export function friendlyTool(tool: string): string {
  const key = `tool.friendly.${tool}`;
  const value = t(key);
  if (value !== key) return value;
  const fallback = t("ui.action_fallback");
  return fallback !== "ui.action_fallback" ? fallback : "Action";
}
