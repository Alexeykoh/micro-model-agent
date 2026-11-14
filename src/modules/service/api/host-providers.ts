/**
 * `/v1/host/providers` (split W11): список и CRUD записей провайдера.
 *
 * Те же чистые операции, что у `/api/providers` (`runtime/providers-*`), но
 * источник правды — конфиг демона; персист и reconfigure идут его доками.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildProviderViews } from "../../../runtime/providers-view";
import { parseProviderInput } from "../../../runtime/providers-input";
import { removeProvider, upsertProvider } from "../../../runtime/providers-write";
import { persistAndReconfigure } from "../../../runtime/persist-config";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";
import { MAX_JSON_BYTES } from "./tasks-job";

/** Обрабатывает `/v1/host/providers[/:name]`; `false` — путь не наш. */
export async function handleHostProviders(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts[2] !== "providers") return false;
  if (parts.length === 3 && req.method === "GET") {
    sendJson(res, 200, buildProviderViews(s.config));
    return true;
  }
  if (parts.length === 3 && req.method === "POST") return createOrUpdate(req, res, s);
  if (parts.length === 4 && req.method === "DELETE") {
    return remove(res, s, decodeURIComponent(parts[3]));
  }
  return false;
}

/** Персист и reconfigure с тем же контрактом `persisted/warning`, что у веба. */
async function persist(s: AgentServiceState) {
  return persistAndReconfigure(
    { saveConfig: s.deps.saveConfig, reconfigure: s.deps.reconfigure, busy: s.pool.anyBusy() },
    s.config,
    "provider.active",
  );
}

async function createOrUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  // Смена провайдера во время хода ломает живой раннер (аудит §7.9).
  if (s.pool.anyBusy()) {
    sendJson(res, 409, { ok: false, error: "busy" });
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const input = parseProviderInput(body);
  if (!input) {
    sendJson(res, 400, { ok: false, error: "invalid-provider" });
    return true;
  }
  const result = upsertProvider(s.config, input);
  if (!result.ok) {
    sendJson(res, 409, { ok: false, error: "name-conflict" });
    return true;
  }
  const saved = await persist(s);
  sendJson(res, 200, { ok: true, name: result.name, ...buildProviderViews(s.config), ...saved });
  return true;
}

async function remove(res: ServerResponse, s: AgentServiceState, name: string): Promise<boolean> {
  if (!name) {
    sendJson(res, 400, { ok: false, error: "invalid-name" });
    return true;
  }
  const outcome = removeProvider(s.config, name);
  if (outcome === "active") {
    sendJson(res, 409, { ok: false, error: "active-provider" });
    return true;
  }
  if (outcome === "missing") {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return true;
  }
  const saved = await persist(s);
  sendJson(res, 200, { ok: true, ...buildProviderViews(s.config), ...saved });
  return true;
}
