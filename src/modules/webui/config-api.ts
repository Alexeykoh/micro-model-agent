/**
 * REST handlers for config / session / model surfaces of `mma web`.
 *
 * Split out of `server.ts` (rule #1: ≤300 lines/file). Every handler takes the
 * shared {@link WebUiState} and reads the optional collaborators the module
 * wires from bootstrap (`config`, `sessionManager`, `saveConfig`,
 * `reconfigure`, `knownModels`). A missing collaborator is a server-side wiring
 * gap, not a client error: those endpoints answer 503 instead of crashing.
 *
 * Auth + same-origin are enforced upstream in `server.ts`; these functions
 * assume the request already passed both checks.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactConfigSecrets } from "../../config/redact";
import { configDefs, setConfigValue } from "../../config/registry";
import { handleSessionHistory } from "./history-api";
import { readBody, readBodyError, sendJson } from "./util";
import type { WebUiState } from "./state";

/** Registry entry shape consumed by the settings UI. */
export interface ConfigRegistryEntry {
  key: string;
  aliases: string[];
  valueType: string;
  group: string;
  enum?: readonly string[];
}

/** Serialize the registry in registry order (canonical keys only). */
export function buildConfigRegistry(): ConfigRegistryEntry[] {
  return configDefs().map((def) => {
    const entry: ConfigRegistryEntry = {
      key: def.key,
      aliases: def.aliases,
      valueType: def.valueType,
      group: def.domain,
    };
    if (def.enumValues) entry.enum = def.enumValues;
    return entry;
  });
}

/** `GET /api/config` — redacted live config + key registry. */
export function handleConfigGet(res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, {
    config: redactConfigSecrets(s.config),
    registry: buildConfigRegistry(),
  });
}

/** Coerce a JSON `value` into the raw string `setConfigValue` expects. */
function toRawValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** `POST /api/config {key, value}` — validate, apply, persist, reconfigure. */
export function handleConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  readBody(req, s.maxBodyBytes)
    .then(async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const rec =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const key = typeof rec.key === "string" ? rec.key : "";
      const rawValue = toRawValue(rec.value);
      if (!key || rawValue === null) {
        sendJson(res, 400, { ok: false, error: "invalid-value" });
        return;
      }

      const result = setConfigValue(config, key, rawValue);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.reason });
        return;
      }

      // Persist first, then reconfigure. Neither failure is swallowed: the UI
      // needs `persisted`/`warning` to tell "saved" from "changed in memory
      // only". A failed write must not leave the agent pointing at settings
      // that were never saved; a failed reconfigure leaves it inconsistent.
      let persisted = true;
      let warning: string | undefined;
      try {
        s.saveConfig?.(config);
      } catch {
        persisted = false;
        warning = "config not persisted";
      }
      if (result.reconfigure && s.reconfigure) {
        try {
          await s.reconfigure(config);
        } catch {
          warning = warning ? `${warning}; reconfigure failed` : "reconfigure failed";
        }
      }
      const body: Record<string, unknown> = {
        ok: true,
        value: result.value,
        display: result.display,
        persisted,
      };
      if (warning) body.warning = warning;
      sendJson(res, 200, body);
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `GET /api/sessions` — list sessions (id/name/updatedAt/model/messageCount). */
export function handleSessionsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const sessions = s.sessionManager.list().map((meta) => ({
    id: meta.id,
    name: meta.name,
    updatedAt: meta.updatedAt,
    model: meta.model,
    messageCount: meta.messageCount,
  }));
  sendJson(res, 200, { sessions });
}

/** `POST /api/sessions/activate {id}` — switch the active session. */
export function handleSessionActivate(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  const manager = s.sessionManager;
  readBody(req, s.maxBodyBytes)
    .then((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid JSON" });
        return;
      }
      const rec =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const id = typeof rec.id === "string" ? rec.id : "";
      if (!id) {
        sendJson(res, 400, { error: "missing id" });
        return;
      }
      try {
        manager.setActive(id);
      } catch {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      sendJson(res, 200, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * `DELETE /api/sessions/:id` — remove a session.
 *
 * Guard: the ACTIVE session cannot be deleted (409 `active_session`). Deleting
 * it would leave the agent pointing at a vanished session file mid-turn; the UI
 * must switch away first. Unknown ids answer 404.
 */
export function handleSessionDelete(res: ServerResponse, id: string, s: WebUiState): void {
  if (!s.sessionManager) {
    sendJson(res, 503, { error: "sessions_unavailable" });
    return;
  }
  if (!id || !s.sessionManager.get(id)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (s.sessionManager.getActive() === id) {
    sendJson(res, 409, { error: "active_session" });
    return;
  }
  try {
    s.sessionManager.delete(id);
  } catch {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * Dispatch `/api/sessions*` routes. Returns whether the request was handled so
 * `server.ts` keeps a flat chain without duplicating path parsing here.
 */
export function handleSessionsApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  const p = reqUrl.pathname;
  if (p === "/api/sessions" && req.method === "GET") {
    handleSessionsGet(res, s);
    return true;
  }
  if (p === "/api/sessions/activate" && req.method === "POST") {
    handleSessionActivate(req, res, s);
    return true;
  }
  if (p.startsWith("/api/sessions/") && p.endsWith("/history") && req.method === "GET") {
    const id = decodeURIComponent(p.slice("/api/sessions/".length, -"/history".length));
    handleSessionHistory(res, id, s);
    return true;
  }
  if (p.startsWith("/api/sessions/") && req.method === "DELETE") {
    const id = decodeURIComponent(p.slice("/api/sessions/".length));
    handleSessionDelete(res, id, s);
    return true;
  }
  return false;
}

/** `GET /api/models` — model ids known to the active provider. */
export function handleModelsGet(res: ServerResponse, s: WebUiState): void {
  if (!s.knownModels) {
    sendJson(res, 503, { error: "models_unavailable" });
    return;
  }
  sendJson(res, 200, { models: s.knownModels() });
}
