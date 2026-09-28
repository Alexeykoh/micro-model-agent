import { pc } from "./colors";

/**
 * Canonical chat glyphs — the single source of truth.
 * See `docs/design/ui/STYLE.md`. Do not invent per-module markers.
 */
export const glyph = {
  /** An action (localized tool label follows). */
  action: "◇",
  success: "✓",
  failure: "✗",
  warning: "⚠",
  /** Reasoning / thinking. */
  thinking: "✦",
  question: "?",
  /** User input echoed in the transcript. */
  user: "↵",
  /** Detail or recovery hint. */
  detail: "↳",
  /** Continuation of a grouped run. */
  group: "│",
  /** Metric summary line. */
  metric: "⟡",
  /** Compaction / refresh. */
  compact: "⟳",
} as const;

export type Glyph = (typeof glyph)[keyof typeof glyph];

/**
 * How much chat output the user wants.
 * - `quiet` (default): one line per action, metrics once per turn.
 * - `normal`: adds short result summaries.
 * - `verbose`: full per-action detail.
 */
export type Verbosity = "quiet" | "normal" | "verbose";

export function isVerbosity(value: unknown): value is Verbosity {
  return value === "quiet" || value === "normal" || value === "verbose";
}

/**
 * Resolve the effective verbosity from config. Explicit `verbosity` wins;
 * otherwise the legacy boolean `verbose` maps to `verbose`/`quiet`.
 */
export function resolveVerbosity(ui?: {
  verbose?: boolean;
  verbosity?: Verbosity;
}): Verbosity {
  if (ui?.verbosity) return ui.verbosity;
  return ui?.verbose ? "verbose" : "quiet";
}

/** Accent-colored action mark. */
export function actionMark(): string {
  return pc.cyan(glyph.action);
}

/** Tool categories — the action glyph keeps one shape, its color encodes kind. */
export type ToolCategory = "recon" | "mutate" | "execute" | "meta";

const CATEGORY_TOOLS: Record<ToolCategory, ReadonlySet<string>> = {
  recon: new Set([
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "file_info",
    "project_map",
    "chunk_query",
    "web_search",
    "web_fetch",
    "web_browse",
    "search_history",
    "recall",
    "session_info",
    "process_list",
    "process_log",
    "process_wait",
  ]),
  mutate: new Set([
    "write_file",
    "edit_file",
    "create_dir",
    "delete_file",
    "move_file",
    "attach_image",
  ]),
  execute: new Set([
    "bash",
    "process_kill",
    "pipeline_run",
    "browser",
    "download_file",
    "subagent",
    "mcp_call",
  ]),
  meta: new Set([
    "plan",
    "plan_step",
    "todo",
    "verify",
    "lsp_check",
    "enable_tools",
    "set_thinking",
    "load_skill",
    "remember",
  ]),
};

export function toolCategory(tool: string): ToolCategory {
  for (const [category, tools] of Object.entries(CATEGORY_TOOLS) as [
    ToolCategory,
    ReadonlySet<string>,
  ][]) {
    if (tools.has(tool)) return category;
  }
  return "meta";
}

/**
 * Accent color function for a tool category. The same color is applied to the
 * action glyph **and** the localized tool label, so they read as one unit
 * (see `docs/design/ui/STYLE.md`). Colors stay off the semantic success/warning/
 * error set so a colored label never reads as an outcome.
 */
export function toolAccent(tool: string): (text: string) => string {
  switch (toolCategory(tool)) {
    case "recon":
      return pc.cyan;
    case "mutate":
      return pc.magenta;
    case "execute":
      return pc.blue;
    default:
      return pc.dim;
  }
}

/** Action mark colored by tool category. */
export function actionMarkFor(tool: string): string {
  return toolAccent(tool)(glyph.action);
}

/** Green success mark. */
export function successMark(): string {
  return pc.green(glyph.success);
}

/** Red failure mark — reserved for real failures, never soft guards. */
export function failureMark(): string {
  return pc.red(glyph.failure);
}

/** Yellow warning mark — soft blocks, protected paths, non-fatal issues. */
export function warningMark(): string {
  return pc.yellow(glyph.warning);
}

/** Dim detail/hint mark. */
export function detailMark(): string {
  return pc.dim(glyph.detail);
}

/** Human duration: `ms` under a second, `s` above (matches the mockup). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
