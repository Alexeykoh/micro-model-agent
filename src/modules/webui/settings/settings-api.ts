// REST-хендлеры страниц настроек Memory / Skills / Plugins·MCP `mma web`.
// Вынесены из `server.ts`. Без коллаборатора — пробел wiring: такие точки отвечают 503.
// Auth и same-origin — выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactContextSecrets } from "../../../core/agent/context-log";
import { readBodyError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import type { WebUiState } from "../state";
import type { AppConfig, MCPServerConfigEntry } from "../../../config/types";
import { DEFAULT_LSP_CONFIG } from "../../lsp/config";

/** Append-only категории памяти (зеркало `memory-commands.ts` / `MemoryStore`). */
const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

function isCategory(value: string): value is (typeof MEMORY_CATEGORIES)[number] {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/** Запись памяти: номер и текст. */
interface MemoryEntry {
  n: number;
  text: string;
}

/** Режет append-only файл категории на записи с нумерацией от 1 (`- `-блоки). */
function listEntries(markdown: string): MemoryEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) entries.push({ n: entries.length + 1, text: line });
  }
  return entries;
}

/** `GET /api/memory` — преференсы + записи по категориям (секреты вычищены). */
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

/** `POST /api/memory {category, text}` — дописать запись. */
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

/** `DELETE /api/memory/:category/:n` — забыть n-ю запись. */
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

/** `GET /api/skills` — доступные скиллы с флагом загруженности. */
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

/** MCP-серверы проекта в форме для UI настроек. */
export interface McpServerView {
  id: string;
  name: string;
  status: string;
  transport?: string;
  /** Несекретные поля соединения (безопасно эхом для префилла правки). */
  command?: string;
  url?: string;
  args?: string[];
  timeout?: number;
  enabled?: boolean;
  /** Секрет-носящие мапы отдаются только именами ключей, никогда значениями. */
  envKeys: string[];
  headerKeys: string[];
}

/** Опциональные несекретные поля MCP для вида (держат гейт сложности). */
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

/** `GET /api/plugins` — зарегистрированные плагины + настроенные MCP-серверы. */
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
 * `POST /api/mcp/:id {enabled}` — тоггл настроенного MCP-сервера.
 *
 * `config.mcpServers[id].enabled` — флаг, фильтруемый MCP-модулем на bootstrap,
 * так что смена персистится и вступает со следующего запуска (MCP-соединения
 * через `agent.reconfigure` не переподнимаются). Ответ несёт
 * `restartRequired: true`, чтобы UI так и сказал.
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

/** Транспорты записи MCP-сервера (`MCPServerConfigEntry`). */
const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;

/** Итог записи MCP: id или код ошибки. */
export type McpWriteResult = { ok: true; id: string } | { ok: false; error: string };

/** Итог записи LSP: язык или код ошибки. */
export type LspWriteResult = { ok: true; lang: string } | { ok: false; error: string };

/** Read-форма строки LSP-сервера (секретов в LSP-конфиге нет). */
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

/** Проверка когерентности смёрженной MCP-записи: транспорт vs command/url + таймаут. */
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

/** Гоняет пополевые апплаеры в порядке таблицы; первая ошибка побеждает. */
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

/** Пополевые MCP-апплаеры (правило #17: таблица, без `if`-цепочки). */
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
 * Чистое создание: валидирует `input` и кладёт запись под тримменным именем.
 * Секреты значениями не эхом — вызывающий рендерит маскированный `mcpList`-вид.
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

/** Чистая полная/частичная правка MCP-записи (ключ остаётся `id`). */
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

/** Чистое удаление MCP-записи. */
export function deleteMcpServer(config: AppConfig, id: string): McpWriteResult {
  if (!config.mcpServers?.[id]) return { ok: false, error: "not_found" };
  delete config.mcpServers[id];
  return { ok: true, id };
}

/** Чистое чтение: таблица LSP-серверов (фолбэк — встроенные дефолты). */
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

/** Пополевые LSP-апплаеры (правило #17: таблица, без `if`-цепочки). */
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

/** Пополевой LSP-патч; возвращает код ошибки или null. */
function applyLspPatch(
  srv: { enabled?: boolean; command: string; args?: string[]; timeout?: number },
  patch: Record<string, unknown>,
): string | null {
  return applyFields(srv, patch, LSP_FIELD_APPLIERS);
}

/** Чистая правка одного LSP-сервера (секцию `lsp` поднимает из дефолтов, если нет). */
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

/** Best-effort персист; бросающий `saveConfig` не должен стать 500-й. */
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
 * Общий конверт пишущих точек конфига: 503 без конфига, 400 на битом JSON,
 * затем чистая мутация. Успех персистится и флажит `restartRequired`
 * (MCP/LSP-соединения (пере-)поднимаются только на bootstrap).
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

/** Маппит чистый `McpWriteResult` на исход конверта (разводка 400/404). */
function mcpOutcome(result: McpWriteResult): ConfigWriteOutcome {
  if (result.ok) return { ok: true };
  return { ok: false, status: result.error === "not_found" ? 404 : 400, error: result.error };
}

/**
 * `POST /api/mcp` — создать настроенный MCP-сервер.
 * Персистится и вступает со следующего запуска (`restartRequired: true`).
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

/** `PUT /api/mcp/:id` — полная/частичная правка настроенного MCP-сервера. */
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

/** `DELETE /api/mcp/:id` — снять настроенный MCP-сервер. */
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

/** `GET /api/lsp` — таблица LSP-серверов. */
export function handleLspGet(res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, { servers: listLspServers(s.config) });
}

/** `PUT /api/lsp/:lang {enabled?,timeout?,command?,args?}` — правит один LSP-сервер. */
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

/** Точные роуты настроек `METHOD путь` (правило #17: карта хендлеров, без `if`). */
const SETTINGS_EXACT: Record<string, SettingsHandler> = {
  "GET /api/memory": (_req, res, _param, s) => handleMemoryGet(res, s),
  "POST /api/memory": (req, res, _param, s) => handleMemoryPost(req, res, s),
  "GET /api/skills": (_req, res, _param, s) => handleSkillsGet(res, s),
  "GET /api/plugins": (_req, res, _param, s) => handlePluginsGet(res, s),
};

/** Префиксные роуты настроек с одним параметром пути (правило #17). */
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
 * Диспатч роутов настроек. Возвращает, обработан ли запрос, чтобы `server.ts`
 * держал плоскую цепочку без дубля парсинга путей.
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
