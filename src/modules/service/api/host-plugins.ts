/**
 * `GET /v1/host/plugins` — плагины, отказы загрузки и MCP-серверы
 * (split W4b-3). Форма совпадает с web, адаптер отдаёт её как есть.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { mcpServersView } from "../../../runtime/mcp-view";
import { sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

/** `/v1/host/plugins`; `true` — запрос обработан. */
export function handleHostPlugins(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): boolean {
  if (parts.length !== 3 || parts[2] !== "plugins" || req.method !== "GET") return false;
  const plugins = s.deps.plugins;
  if (!plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return true;
  }
  sendJson(res, 200, {
    plugins: plugins.getRecords(),
    failures: plugins.getFailures(),
    mcp: mcpServersView(s.config),
  });
  return true;
}
