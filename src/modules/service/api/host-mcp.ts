/**
 * `/v1/host/mcp` (split W11): список и CRUD настроенных MCP-серверов.
 *
 * Только конфиг: MCP-соединения поднимаются на bootstrap, поэтому ответ несёт
 * `restartRequired` — как и у локального веба. Секреты не эхом (вид маскирует).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { mcpServersView } from "../../../runtime/mcp-view";
import { createMcpServer, deleteMcpServer, updateMcpServer } from "../../../runtime/mcp-write";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";
import { MAX_JSON_BYTES } from "./tasks-job";

/** Обрабатывает `/v1/host/mcp[/:id]`; `false` — путь не наш. */
export async function handleHostMcp(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts[2] !== "mcp") return false;
  if (parts.length === 3 && req.method === "GET") {
    sendJson(res, 200, { mcp: mcpServersView(s.config) });
    return true;
  }
  if (parts.length === 3 && req.method === "POST") return create(req, res, s);
  const id = parts.length === 4 ? decodeURIComponent(parts[3]) : "";
  if (id && req.method === "POST") return toggle(req, res, s, id);
  if (id && req.method === "PUT") return update(req, res, s, id);
  if (id && req.method === "DELETE") return remove(res, s, id);
  return false;
}

/** Best-effort персист без reconfigure: соединения живут до рестарта. */
function persist(s: AgentServiceState): boolean {
  try {
    s.deps.saveConfig?.(s.config);
    return true;
  } catch {
    return false;
  }
}

function respond(res: ServerResponse, s: AgentServiceState): void {
  sendJson(res, 200, {
    ok: true,
    persisted: persist(s),
    restartRequired: true,
    mcp: mcpServersView(s.config),
  });
}

async function create(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const result = createMcpServer(s.config, body);
  if (!result.ok) return fail(res, result.error);
  respond(res, s);
  return true;
}

async function toggle(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  id: string,
): Promise<boolean> {
  const entry = s.config.mcpServers?.[id];
  if (!entry) return fail(res, "not_found", 404);
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  if (typeof body.enabled !== "boolean") return fail(res, "invalid-enabled", 400);
  entry.enabled = body.enabled;
  respond(res, s);
  return true;
}

async function update(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  id: string,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const result = updateMcpServer(s.config, id, body);
  if (!result.ok) return fail(res, result.error);
  respond(res, s);
  return true;
}

function remove(res: ServerResponse, s: AgentServiceState, id: string): boolean {
  const result = deleteMcpServer(s.config, id);
  if (!result.ok) return fail(res, result.error, 404);
  respond(res, s);
  return true;
}

/** Ошибка записи: 404 для отсутствующей записи, иначе 400. */
function fail(res: ServerResponse, error: string, status = 400): true {
  sendJson(res, status, { ok: false, error });
  return true;
}
