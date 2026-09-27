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
import { readBodyError, sendJson } from "./util";
import { readJsonBody } from "./body";
import type { WebUiState } from "./state";
import type { AppConfig, MCPServerConfigEntry } from "../../config/types";
import { DEFAULT_LSP_CONFIG } from "../lsp/config";

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
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
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

/** Project configured MCP servers into the settings UI shape. */
export interface McpServerView {
  id: string;
  name: string;
  status: string;
  transport?: string;
  /** Non-secret connection fields (safe to echo for edit prefill). */
  command?: string;
  url?: string;
  args?: string[];
  timeout?: number;
  enabled?: boolean;
  /** Secret-bearing maps are exposed as key names only, never values. */
  envKeys: string[];
  headerKeys: string[];
}

/** Optional non-secret MCP fields merged into the view (stays under the complexity gate). */
function mcpViewOptionals(cfg: MCPServerConfigEntry): Partial<McpServerView> {
  const out: Partial<McpServerView> = {};
  if (cfg.transport) out.transport = cfg.transport;
  if (cfg.command) out.command = cfg.command;
  if (cfg.url) out.url = cfg.url;
  if (cfg.args) out.args = [...cfg.args];
  if (cfg.timeout !== undefined) out.timeout = cfg.timeout;
  if (cfg.enabled !== undefined) out.enabled = cfg.enabled;
  return out;
}

function mcpList(s: WebUiState): McpServerView[] {
  const servers = s.config?.mcpServers ?? {};
  return Object.entries(servers).map(([key, cfg]) => ({
    id: key,
    name: cfg.name || key,
    status: cfg.enabled === false ? "disabled" : "enabled",
    envKeys: cfg.env ? Object.keys(cfg.env) : [],
    headerKeys: cfg.headers ? Object.keys(cfg.headers) : [],
    ...mcpViewOptionals(cfg),
  }));
}

/** `GET /api/plugins` — registered plugins + configured MCP servers. */
export function handlePluginsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return;
  }
  const plugins = s.plugins.getPluginInfos().map(({ plugin, source }) => {
    const info: Record<string, unknown> = {
      name: plugin.name,
      enabled: true,
      builtin: plugin.isBuiltin === true,
    };
    if (plugin.version) info.version = plugin.version;
    const src = source || plugin.source;
    if (src) info.source = src;
    return info;
  });
  sendJson(res, 200, { plugins, mcp: mcpList(s) });
}

/**
 * `POST /api/mcp/:id {enabled}` — toggle a configured MCP server.
 *
 * `config.mcpServers[id].enabled` is the flag the MCP module filters on at
 * bootstrap, so the change is persisted and takes effect on the next run (MCP
 * connections are not re-established by `agent.reconfigure`). The response
 * carries `restartRequired: true` so the UI can say so.
 */
export function handleMcpToggle(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  s: WebUiState,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  const entry = config.mcpServers?.[id];
  if (!entry) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      if (typeof rec.enabled !== "boolean") {
        sendJson(res, 400, { ok: false, error: "invalid-enabled" });
        return;
      }
      config.mcpServers[id] = { ...entry, enabled: rec.enabled };
      let persisted = true;
      try {
        s.saveConfig?.(config);
      } catch {
        persisted = false;
      }
      sendJson(res, 200, { ok: true, persisted, restartRequired: true, mcp: mcpList(s) });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** Transports accepted for an MCP server entry (`MCPServerConfigEntry`). */
const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;

export type McpWriteResult = { ok: true; id: string } | { ok: false; error: string };

export type LspWriteResult = { ok: true; lang: string } | { ok: false; error: string };

/** Read shape for one LSP server row (no secrets exist in LSP config). */
export interface LspServerView {
  lang: string;
  command: string;
  args?: string[];
  timeout: number;
  autoInstall: boolean;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((x) => typeof x === "string")) return null;
  return [...value];
}

function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 300000;
}

/** Coherence check on a merged MCP entry: transport vs command/url + timeout. */
function validateMcpEntry(entry: MCPServerConfigEntry): string | null {
  const transport = entry.transport ?? "stdio";
  if (!(MCP_TRANSPORTS as readonly string[]).includes(transport)) return "invalid-transport";
  if (transport === "stdio") {
    if (!entry.command?.trim()) return "command-required";
  } else if (!entry.url?.trim()) {
    return "url-required";
  }
  if (entry.timeout !== undefined && !validTimeout(entry.timeout)) return "invalid-timeout";
  return null;
}

type FieldApplier<T> = (target: T, value: unknown) => string | null;

/** Run the per-field appliers in table order; first error wins. */
function applyFields<T>(
  target: T,
  patch: Record<string, unknown>,
  appliers: Record<string, FieldApplier<T>>,
): string | null {
  for (const [key, apply] of Object.entries(appliers)) {
    const value = patch[key];
    if (value === undefined) continue;
    const error = apply(target, value);
    if (error) return error;
  }
  return null;
}

function setTrimmed(
  value: unknown,
  code: string,
  set: (text: string) => void,
  clear: () => void,
): string | null {
  if (typeof value !== "string") return code;
  if (value.trim()) set(value.trim());
  else clear();
  return null;
}

/** Per-field MCP appliers (rule #17: table, no `if` chain). */
const MCP_FIELD_APPLIERS: Record<string, FieldApplier<MCPServerConfigEntry>> = {
  name: (next, v) => {
    if (typeof v !== "string" || !v.trim()) return "name-required";
    next.name = v.trim();
    return null;
  },
  transport: (next, v) => {
    if (typeof v !== "string") return "invalid-transport";
    next.transport = v as MCPServerConfigEntry["transport"];
    return null;
  },
  command: (next, v) =>
    setTrimmed(v, "invalid-command", (t) => { next.command = t; }, () => { delete next.command; }),
  url: (next, v) =>
    setTrimmed(v, "invalid-url", (t) => { next.url = t; }, () => { delete next.url; }),
  args: (next, v) => {
    const args = asStringArray(v);
    if (!args) return "invalid-args";
    next.args = args;
    return null;
  },
  env: (next, v) => {
    const env = asStringRecord(v);
    if (!env) return "invalid-env";
    next.env = env;
    return null;
  },
  headers: (next, v) => {
    const headers = asStringRecord(v);
    if (!headers) return "invalid-headers";
    next.headers = headers;
    return null;
  },
  enabled: (next, v) => {
    if (typeof v !== "boolean") return "invalid-enabled";
    next.enabled = v;
    return null;
  },
  timeout: (next, v) => {
    if (!validTimeout(v)) return "invalid-timeout";
    next.timeout = v;
    return null;
  },
};

function applyMcpPatch(
  next: MCPServerConfigEntry,
  patch: Record<string, unknown>,
): string | null {
  return applyFields(next, patch, MCP_FIELD_APPLIERS);
}

/**
 * Pure create: validates `input` and stores the entry under its trimmed name.
 * Never echoes secret values — the caller renders the masked `mcpList` view.
 */
export function createMcpServer(config: AppConfig, input: unknown): McpWriteResult {
  if (!isRecord(input)) return { ok: false, error: "invalid-input" };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "name-required" };
  if (!config.mcpServers) config.mcpServers = {};
  if (config.mcpServers[name]) return { ok: false, error: "name-conflict" };
  const next: MCPServerConfigEntry = { name };
  const patchError = applyMcpPatch(next, { ...input, name });
  if (patchError) return { ok: false, error: patchError };
  const coherent = validateMcpEntry(next);
  if (coherent) return { ok: false, error: coherent };
  config.mcpServers[name] = next;
  return { ok: true, id: name };
}

/** Pure full/partial edit of an MCP server entry (key stays `id`). */
export function updateMcpServer(
  config: AppConfig,
  id: string,
  patch: unknown,
): McpWriteResult {
  const current = config.mcpServers?.[id];
  if (!current) return { ok: false, error: "not_found" };
  if (!isRecord(patch)) return { ok: false, error: "invalid-input" };
  const next: MCPServerConfigEntry = { ...current };
  const patchError = applyMcpPatch(next, patch);
  if (patchError) return { ok: false, error: patchError };
  const coherent = validateMcpEntry(next);
  if (coherent) return { ok: false, error: coherent };
  config.mcpServers[id] = next;
  return { ok: true, id };
}

/** Pure delete of an MCP server entry. */
export function deleteMcpServer(config: AppConfig, id: string): McpWriteResult {
  if (!config.mcpServers?.[id]) return { ok: false, error: "not_found" };
  delete config.mcpServers[id];
  return { ok: true, id };
}

/** Pure read: LSP servers table (falls back to built-in defaults). */
export function listLspServers(config: AppConfig): LspServerView[] {
  const lsp = config.lsp ?? DEFAULT_LSP_CONFIG;
  return Object.entries(lsp.servers).map(([lang, srv]) => {
    const view: LspServerView = {
      lang,
      command: srv.command,
      timeout: srv.timeout ?? lsp.timeout,
      autoInstall: srv.autoInstall ?? false,
      enabled: lsp.enabled !== false && srv.enabled !== false,
    };
    if (srv.args) view.args = [...srv.args];
    return view;
  });
}

/** Per-field LSP appliers (rule #17: table, no `if` chain). */
const LSP_FIELD_APPLIERS: Record<
  string,
  FieldApplier<{ enabled?: boolean; command: string; args?: string[]; timeout?: number }>
> = {
  enabled: (srv, v) => {
    if (typeof v !== "boolean") return "invalid-enabled";
    srv.enabled = v;
    return null;
  },
  command: (srv, v) => {
    if (typeof v !== "string" || !v.trim()) return "invalid-command";
    srv.command = v.trim();
    return null;
  },
  args: (srv, v) => {
    const args = asStringArray(v);
    if (!args) return "invalid-args";
    srv.args = args;
    return null;
  },
  timeout: (srv, v) => {
    if (!validTimeout(v)) return "invalid-timeout";
    srv.timeout = v;
    return null;
  },
};

/** Field-level LSP patch; returns the error code or null. */
function applyLspPatch(
  srv: { enabled?: boolean; command: string; args?: string[]; timeout?: number },
  patch: Record<string, unknown>,
): string | null {
  return applyFields(srv, patch, LSP_FIELD_APPLIERS);
}

/** Pure edit of one LSP server (creates the `lsp` section from defaults when absent). */
export function updateLspServer(
  config: AppConfig,
  lang: string,
  patch: unknown,
): LspWriteResult {
  if (!isRecord(patch)) return { ok: false, error: "invalid-input" };
  if (!config.lsp) config.lsp = structuredClone(DEFAULT_LSP_CONFIG);
  const srv = config.lsp.servers[lang];
  if (!srv) return { ok: false, error: "not_found" };
  const patchError = applyLspPatch(srv, patch);
  if (patchError) return { ok: false, error: patchError };
  return { ok: true, lang };
}

/** Best-effort persist; a throwing `saveConfig` must not become a 500. */
function persistConfig(s: WebUiState, config: AppConfig): boolean {
  try {
    s.saveConfig?.(config);
    return true;
  } catch {
    return false;
  }
}

type ConfigWriteOutcome =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Shared envelope for config write endpoints: 503 without config, 400 on bad
 * JSON, then the pure mutation. Success persists and flags `restartRequired`
 * (MCP/LSP connections are only (re-)established at bootstrap).
 */
function handleConfigWrite(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
  mutate: (config: AppConfig, body: Record<string, unknown>) => ConfigWriteOutcome,
  view: (config: AppConfig, state: WebUiState) => Record<string, unknown>,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const outcome = mutate(config, rec);
      if (!outcome.ok) {
        sendJson(res, outcome.status, { ok: false, error: outcome.error });
        return;
      }
      const persisted = persistConfig(s, config);
      sendJson(res, 200, { ok: true, persisted, restartRequired: true, ...view(config, s) });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** Map a pure `McpWriteResult` onto the shared envelope outcome (400/404 split). */
function mcpOutcome(result: McpWriteResult): ConfigWriteOutcome {
  if (result.ok) return { ok: true };
  return { ok: false, status: result.error === "not_found" ? 404 : 400, error: result.error };
}

/**
 * `POST /api/mcp` — create a configured MCP server.
 * Persisted and takes effect on the next run (`restartRequired: true`).
 */
export function handleMcpCreate(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  handleConfigWrite(
    req,
    res,
    s,
    (config, rec) => mcpOutcome(createMcpServer(config, rec)),
    (_config, state) => ({ mcp: mcpList(state) }),
  );
}

/** `PUT /api/mcp/:id` — full/partial edit of a configured MCP server. */
export function handleMcpUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  s: WebUiState,
): void {
  handleConfigWrite(
    req,
    res,
    s,
    (config, rec) => mcpOutcome(updateMcpServer(config, id, rec)),
    (_config, state) => ({ mcp: mcpList(state) }),
  );
}

/** `DELETE /api/mcp/:id` — remove a configured MCP server. */
export function handleMcpDelete(res: ServerResponse, id: string, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const result = deleteMcpServer(s.config, id);
  if (!result.ok) {
    sendJson(res, 404, { ok: false, error: result.error });
    return;
  }
  const persisted = persistConfig(s, s.config);
  sendJson(res, 200, { ok: true, persisted, restartRequired: true, mcp: mcpList(s) });
}

/** `GET /api/lsp` — LSP servers table. */
export function handleLspGet(res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, { servers: listLspServers(s.config) });
}

/** `PUT /api/lsp/:lang {enabled?,timeout?,command?,args?}` — edit one LSP server. */
export function handleLspUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  lang: string,
  s: WebUiState,
): void {
  handleConfigWrite(
    req,
    res,
    s,
    (config, rec) => {
      const result = updateLspServer(config, lang, rec);
      if (result.ok) return { ok: true };
      return { ok: false, status: result.error === "not_found" ? 404 : 400, error: result.error };
    },
    (config) => ({ servers: listLspServers(config) }),
  );
}

type SettingsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  param: string,
  s: WebUiState,
) => void;

/** Exact `METHOD path` settings routes (rule #17: handler map, no `if` chain). */
const SETTINGS_EXACT: Record<string, SettingsHandler> = {
  "GET /api/memory": (_req, res, _param, s) => handleMemoryGet(res, s),
  "POST /api/memory": (req, res, _param, s) => handleMemoryPost(req, res, s),
  "GET /api/skills": (_req, res, _param, s) => handleSkillsGet(res, s),
  "GET /api/plugins": (_req, res, _param, s) => handlePluginsGet(res, s),
};

/** Prefix settings routes carrying one path parameter (rule #17). */
const SETTINGS_PREFIX: Array<{ method: string; prefix: string; handle: SettingsHandler }> = [
  {
    method: "DELETE",
    prefix: "/api/memory/",
    handle: (_req, res, param, s) => {
      const slash = param.indexOf("/");
      handleMemoryDelete(
        res,
        slash >= 0 ? decodeURIComponent(param.slice(0, slash)) : "",
        slash >= 0 ? decodeURIComponent(param.slice(slash + 1)) : "",
        s,
      );
    },
  },
  {
    method: "POST",
    prefix: "/api/mcp/",
    handle: (req, res, param, s) => handleMcpToggle(req, res, decodeURIComponent(param), s),
  },
  {
    method: "PUT",
    prefix: "/api/mcp/",
    handle: (req, res, param, s) => handleMcpUpdate(req, res, decodeURIComponent(param), s),
  },
  {
    method: "DELETE",
    prefix: "/api/mcp/",
    handle: (_req, res, param, s) => handleMcpDelete(res, decodeURIComponent(param), s),
  },
  {
    method: "PUT",
    prefix: "/api/lsp/",
    handle: (req, res, param, s) => handleLspUpdate(req, res, decodeURIComponent(param), s),
  },
];

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
  const exact = SETTINGS_EXACT[`${req.method} ${p}`];
  if (exact) {
    exact(req, res, "", s);
    return true;
  }
  for (const route of SETTINGS_PREFIX) {
    if (req.method === route.method && p.startsWith(route.prefix)) {
      route.handle(req, res, p.slice(route.prefix.length), s);
      return true;
    }
  }
  return false;
}
