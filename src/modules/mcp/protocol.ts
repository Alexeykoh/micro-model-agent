// Общие типы MCP-протокола (транспорты и клиент): форма тула и Accept-заголовок.

/**
 * Accept-заголовок для MCP Streamable HTTP: сервер отвечает 406, если клиент
 * не принимает оба media type.
 */
export const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

/** Описание тула, как его отдаёт `tools/list`. */
export interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
