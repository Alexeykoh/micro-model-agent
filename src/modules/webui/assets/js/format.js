// Pure formatting helpers + tool taxonomy for the `mma web` frontend.

import { t } from "./i18n.js";
import { S } from "./store.js";

export const CATEGORIES = {
  recon: [
    "read_file", "list_dir", "glob", "grep", "file_info", "project_map",
    "chunk_query", "web_search", "web_fetch", "history", "recall",
    "process_list", "process_log",
  ],
  mutate: [
    "write_file", "edit_file", "create_dir", "delete_file", "move_file",
    "attach_image",
  ],
  execute: [
    "bash", "process_kill", "pipeline_run", "browser", "download_file",
    "subagent", "mcp_call",
  ],
  meta: [
    "plan", "todo", "verify", "lsp_check", "enable_tools", "set_thinking",
    "load_skill", "remember",
  ],
};

export const FILE_TOOLS = ["read_file", "write_file", "edit_file", "list_dir", "delete_file", "move_file", "file_info"];
// Tools whose `path` argument points at a readable file the viewer can open.
// `list_dir` is a directory, `delete_file`/`move_file` leave the file gone.
export const OPENABLE_TOOLS = ["read_file", "write_file", "edit_file", "file_info"];
export const IMAGE_TOOLS = ["attach_image", "browser"];
export const LINK_TOOLS = ["web_fetch", "download_file"];

export function categoryOf(name) {
  for (const cat of Object.keys(CATEGORIES)) {
    if (CATEGORIES[cat].indexOf(name) !== -1) return cat;
  }
  return "meta";
}

// Friendly, localized tool label from `tool.friendly.*`; humanize unknown names.
export function labelOf(name) {
  const key = "tool.friendly." + name;
  const s = t(key);
  if (s !== key) return s;
  const human = String(name).replace(/_/g, " ");
  return human.charAt(0).toUpperCase() + human.slice(1);
}

export function argText(args) {
  if (!args || typeof args !== "object") return "";
  const keys = ["path", "file", "dir", "command", "query", "url", "pattern", "name", "id", "text", "prompt"];
  for (const key of keys) {
    if (typeof args[key] === "string" && args[key]) return args[key];
  }
  const keys2 = Object.keys(args);
  if (!keys2.length) return "";
  const val = args[keys2[0]];
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    const json = JSON.stringify(args);
    return json === "{}" ? "" : json.slice(0, 120);
  } catch (err) {
    return "";
  }
}

export function formatMs(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

// Effective chat verbosity, mirroring `resolveVerbosity` in src/ui/theme.ts:
// explicit `ui.verbosity` wins; the legacy boolean maps to verbose/quiet. A
// fresh config defaults to `quiet`, so the web feed matches the terminal.
export function verbosity() {
  const ui = (S.state.config && S.state.config.ui) || {};
  if (ui.verbosity) return ui.verbosity;
  return ui.verbose ? "verbose" : "quiet";
}

// First non-empty line of a tool result — the calm one-line cause shown in
// quiet mode instead of the whole model-facing body.
export function firstOutputLine(text) {
  if (typeof text !== "string" || !text) return "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) return line.length > 200 ? line.slice(0, 197) + "…" : line;
  }
  return "";
}

export function relTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (!isFinite(diff) || diff < 0) return "";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return min + "m";
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + "h";
  const days = Math.floor(hrs / 24);
  return days + "d";
}

export function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}
// Compact context-window label for selectors and the model panel.
export function contextLabel() {
  const n = (S.state.config && S.state.config.contextWindow) || 0;
  return n ? Math.round(n / 1024) + "K" : "—";
}

