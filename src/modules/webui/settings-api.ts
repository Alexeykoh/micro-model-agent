/**
 * REST handlers for the Memory / Skills / Plugins·MCP settings pages of `mma web`.
 *
 * Split out of `server.ts` (rule #1: ≤300 lines/file). Each handler reads the
 * optional collaborators `module.ts` wires from bootstrap (`memory`, `skills`,
 * `plugins`, `config`). A missing collaborator is a server-side wiring gap, not
 * a client error: those endpoints answer 503 instead of crashing.
 *
 * Auth + same-origin are enforced upstream in `server.ts`; these functions
 * assume the request already passed both checks.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactContextSecrets } from "../../core/agent/context-log";
import { readBody, readBodyError, sendJson } from "./util";
import type { WebUiState } from "./state";

/** Append-only memory categories (mirrors `memory-commands.ts` / `MemoryStore`). */
const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

function isCategory(value: string): value is (typeof MEMORY_CATEGORIES)[number] {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

interface MemoryEntry {
  n: number;
  text: string;
}

/** Split an append-only category file into its 1-based entries (`- ` blocks). */
function listEntries(markdown: string): MemoryEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) entries.push({ n: entries.length + 1, text: line });
  }
  return entries;
}

/** `GET /api/memory` — preferences + entries grouped by category (secrets redacted). */
export function handleMemoryGet(res: ServerResponse, s: WebUiState): void {
  if (!s.memory) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return;
  }
  const store = s.memory;
  const preferences: Record<string, string> = {};
  for (const [key, value] of Object.entries(store.getPreferences())) {
    preferences[key] = redactContextSecrets(String(value));
  }
  const categories = MEMORY_CATEGORIES.map((name) => ({
    name,
    entries: listEntries(store.read(name)).map((e) => ({
      n: e.n,
      text: redactContextSecrets(e.text),
    })),
  }));
  sendJson(res, 200, { preferences, categories });
}

/** `POST /api/memory {category, text}` — append an entry. */
export function handleMemoryPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  if (!s.memory) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return;
  }
  const store = s.memory;
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const rec =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const category = typeof rec.category === "string" ? rec.category : "";
      const text = typeof rec.text === "string" ? rec.text.trim() : "";
      if (!isCategory(category) || text.length === 0) {
        sendJson(res, 400, { ok: false, error: "invalid-entry" });
        return;
      }
      store.append(category, text);
      sendJson(res, 200, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `DELETE /api/memory/:category/:n` — forget the nth entry. */
export function handleMemoryDelete(
  res: ServerResponse,
  category: string,
  nRaw: string,
  s: WebUiState,
): void {
  if (!s.memory) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return;
  }
  if (!isCategory(category)) {
    sendJson(res, 400, { ok: false, error: "invalid-category" });
    return;
  }
  const n = parseInt(nRaw, 10);
  if (!(n > 0) || !s.memory.deleteEntry(category, n)) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/** `GET /api/skills` — available skills with a loaded/enabled indicator. */
export function handleSkillsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.skills) {
    sendJson(res, 503, { error: "skills_unavailable" });
    return;
  }
  const loaded = new Set(s.skills.getLoaded().map((skill) => skill.name));
  const skills = s.skills.getAvailable().map((skill) => {
    const info: Record<string, unknown> = { name: skill.name, enabled: loaded.has(skill.name) };
    if (skill.description) info.description = skill.description;
    if (skill.sourcePath) info.source = skill.sourcePath;
    return info;
  });
  sendJson(res, 200, { skills });
}

/** `GET /api/plugins` — registered plugins + configured MCP servers. */
export function handlePluginsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return;
  }
  const plugins = s.plugins.getPluginInfos().map(({ plugin, source }) => {
    const info: Record<string, unknown> = { name: plugin.name, enabled: true };
    if (plugin.version) info.version = plugin.version;
    const src = source || plugin.source;
    if (src) info.source = src;
    return info;
  });
  const servers = s.config?.mcpServers ?? {};
  const mcp = Object.entries(servers).map(([key, cfg]) => ({
    name: cfg.name || key,
    status: cfg.enabled === false ? "disabled" : "enabled",
  }));
  sendJson(res, 200, { plugins, mcp });
}

/**
 * Dispatch the settings routes. Returns whether the request was handled so
 * `server.ts` keeps a flat chain without duplicating path parsing here.
 */
export function handleSettingsApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  const p = reqUrl.pathname;
  if (p === "/api/memory" && req.method === "GET") {
    handleMemoryGet(res, s);
    return true;
  }
  if (p === "/api/memory" && req.method === "POST") {
    handleMemoryPost(req, res, s);
    return true;
  }
  if (p.startsWith("/api/memory/") && req.method === "DELETE") {
    const rest = p.slice("/api/memory/".length);
    const slash = rest.indexOf("/");
    const category = slash >= 0 ? decodeURIComponent(rest.slice(0, slash)) : "";
    const nRaw = slash >= 0 ? decodeURIComponent(rest.slice(slash + 1)) : "";
    handleMemoryDelete(res, category, nRaw, s);
    return true;
  }
  if (p === "/api/skills" && req.method === "GET") {
    handleSkillsGet(res, s);
    return true;
  }
  if (p === "/api/plugins" && req.method === "GET") {
    handlePluginsGet(res, s);
    return true;
  }
  return false;
}
