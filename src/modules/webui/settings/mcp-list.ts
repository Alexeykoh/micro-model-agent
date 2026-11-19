// `GET /api/mcp` — настроенные MCP-серверы для вкладки MCP в сайдбаре.
// Список собирает `mcpList` (тот же вид, что у настроек), поэтому очистка
// секретов и статусы не могут разойтись между двумя поверхностями.
import type { ServerResponse } from "node:http";
import { sendJson } from "../util";
import type { ConfigStore, HttpTransport, SseTransport, WorkspaceStore } from "../state";
import { mcpServersView } from "../../../runtime/mcp-view";

export function handleMcpList(
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
  sendJson(res, 200, { mcp: mcpServersView(s.config) });
}
