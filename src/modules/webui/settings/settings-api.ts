/**
 * REST-хендлеры страниц настроек Memory / Skills / Plugins·MCP `mma web`.
 * Вынесены из `server.ts`. Без коллаборатора — пробел wiring: такие точки отвечают 503.
 * Auth и same-origin — выше в `server.ts`.
 *
 * Здесь только карта роутов (правило #17); тела — в `settings-api-*.ts`
 * (правило 6, ≤300 строк).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMemoryDelete, handleMemoryGet, handleMemoryPost } from "./memory-api";
import { handleLspUpdate } from "./settings-api-lsp";
import {
  handleMcpDelete,
  handleMcpToggle,
  handleMcpUpdate,
} from "./settings-api-mcp";
import {
  handlePluginToggle,
  handlePluginsGet,
  handlePluginsReload,
  handleSkillsGet,
} from "./settings-api-plugins";
import type { SettingsState } from "./settings-api-write";

export type { McpServerView } from "./settings-api-mcp";
export { createMcpServer, deleteMcpServer, updateMcpServer, type McpWriteResult } from "./settings-api-mcp-write";
export { mcpList } from "./settings-api-mcp";
export { handleLspGet, handleLspUpdate, listLspServers, updateLspServer, type LspServerView, type LspWriteResult } from "./settings-api-lsp";
export { handleMcpCreate, handleMcpDelete, handleMcpToggle, handleMcpUpdate } from "./settings-api-mcp";
export { handlePluginToggle, handlePluginsGet, handlePluginsReload, handleSkillsGet } from "./settings-api-plugins";

type SettingsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  param: string,
  s: SettingsState,
) => void;

/** Точные роуты настроек `METHOD путь` (правило #17: карта хендлеров, без `if`). */
const SETTINGS_EXACT: Record<string, SettingsHandler> = {
  "GET /api/memory": (_req, res, _param, s) => handleMemoryGet(res, s),
  "POST /api/memory": (req, res, _param, s) => handleMemoryPost(req, res, s),
  "GET /api/skills": (_req, res, _param, s) => handleSkillsGet(res, s),
  "GET /api/plugins": (_req, res, _param, s) => handlePluginsGet(res, s),
  // Отдельное пространство действий, а не `/api/plugins/reload`: `reload` —
  // допустимое имя плагина, и exact-first сделал бы его невыключаемым.
  "POST /api/reload/plugins": (_req, res, _param, s) => handlePluginsReload(res, s),
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
    method: "POST",
    prefix: "/api/plugins/",
    handle: (req, res, param, s) => handlePluginToggle(req, res, decodeURIComponent(param), s),
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
  s: SettingsState,
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
