/**
 * REST-хендлеры MCP: список, тумблер и CRUD настроенных серверов.
 * Вынесено из `settings-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import type { MCPServerConfigEntry } from "../../../config/types";
import {
  createMcpServer,
  deleteMcpServer,
  updateMcpServer,
  type McpWriteResult,
} from "./settings-api-mcp-write";
import {
  handleConfigWrite,
  persistConfig,
  type ConfigWriteOutcome,
  type SettingsState,
} from "./settings-api-write";

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

export function mcpList(s: SettingsState): McpServerView[] {
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
  s: SettingsState,
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
        s.saveConfig?.(config, "mcpServers");
      } catch {
        persisted = false;
      }
      sendJson(res, 200, { ok: true, persisted, restartRequired: true, mcp: mcpList(s) });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/** Маппит чистый `McpWriteResult` на исход конверта (разводка 400/404). */
function mcpOutcome(result: McpWriteResult): ConfigWriteOutcome {
  if (result.ok) return { ok: true, key: "mcpServers" };
  return { ok: false, status: result.error === "not_found" ? 404 : 400, error: result.error };
}

/**
 * `POST /api/mcp` — создать настроенный MCP-сервер.
 * Персистится и вступает со следующего запуска (`restartRequired: true`).
 */
export function handleMcpCreate(
  req: IncomingMessage,
  res: ServerResponse,
  s: SettingsState,
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
  s: SettingsState,
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
export function handleMcpDelete(res: ServerResponse, id: string, s: SettingsState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const result = deleteMcpServer(s.config, id);
  if (!result.ok) {
    sendJson(res, 404, { ok: false, error: result.error });
    return;
  }
  const persisted = persistConfig(s, s.config, "mcpServers");
  sendJson(res, 200, { ok: true, persisted, restartRequired: true, mcp: mcpList(s) });
}
