/**
 * REST-хендлеры MCP: список, тумблер и CRUD настроенных серверов.
 * Вынесено из `settings-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
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

export type { McpServerView } from "../../../runtime/mcp-view";
import { mcpServersView } from "../../../runtime/mcp-view";
import type { AppConfig } from "../../../config/types";

/** Список MCP-серверов для web-состояния (обёртка над runtime-видом). */
export function mcpList(s: { config?: AppConfig }): import("../../../runtime/mcp-view").McpServerView[] {
  return mcpServersView(s.config);
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
