/**
 * REST handlers for the "Model & Provider" settings page of `mma web`.
 *
 * Split out of `settings-api.ts` (rule #1: ≤300 lines/file). Adds/updates and
 * deletes entries in `config.provider.entries`, persisting through `saveConfig`
 * and hot-swapping the agent through `reconfigure`. Secrets are never echoed:
 * the read shape exposes `hasApiKey` instead of the key itself.
 *
 * Auth + same-origin are enforced upstream in `server.ts`; these functions
 * assume the request already passed both checks.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig, ProviderEntry } from "../../config/types";
import { readBody, readBodyError, sendJson } from "./util";
import type { WebUiState } from "./state";

/** Redacted provider entry rendered by the settings UI. */
export interface ProviderView {
  type: string;
  label: string;
  baseUrl: string;
  contextWindow?: number;
  priority?: number;
  rpm?: number;
  parallel?: number;
  hasApiKey: boolean;
}

/** Normalize `config.provider` into a display list + active name. */
export function buildProviderViews(config: AppConfig): { entries: ProviderView[]; active: string } {
  const provider = config.provider;
  const raw: ProviderEntry[] =
    Array.isArray(provider.entries) && provider.entries.length > 0
      ? provider.entries
      : [{ type: provider.type, baseUrl: provider.baseUrl, apiKey: provider.apiKey }];
  const entries = raw.map((e) => {
    const view: ProviderView = {
      type: e.type,
      label: e.label || e.type,
      baseUrl: e.baseUrl,
      hasApiKey: Boolean(e.apiKey),
    };
    if (e.contextWindow !== undefined) view.contextWindow = e.contextWindow;
    if (e.priority !== undefined) view.priority = e.priority;
    if (e.rateLimits) {
      view.rpm = e.rateLimits.maxRequestsPerMinute;
      view.parallel = e.rateLimits.maxParallelTasks;
    }
    return view;
  });
  return { entries, active: provider.active || provider.type };
}

/** `GET /api/providers` — redacted entries + active name. */
export function handleProvidersGet(res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, buildProviderViews(s.config));
}

interface ProviderInput {
  type: string;
  label?: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  priority?: number;
  rpm?: number;
  parallel?: number;
}

function optionalInt(rec: Record<string, unknown>, key: string, min: number): number | null | undefined {
  const v = rec[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return null;
  return n;
}

/** Parse + validate the POST body. `null` means "reject with 400". */
function parseProviderInput(rec: Record<string, unknown>): ProviderInput | null {
  const type = typeof rec.type === "string" ? rec.type.trim() : "";
  const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : "";
  if (!type || !baseUrl) return null;
  if (rec.apiKey !== undefined && rec.apiKey !== null && typeof rec.apiKey !== "string") return null;
  if (rec.label !== undefined && rec.label !== null && typeof rec.label !== "string") return null;

  const contextWindow = optionalInt(rec, "contextWindow", 1024);
  const priority = optionalInt(rec, "priority", 0);
  const rpm = optionalInt(rec, "rpm", 1);
  const parallel = optionalInt(rec, "parallel", 1);
  if (contextWindow === null || priority === null || rpm === null || parallel === null) return null;

  const input: ProviderInput = { type, baseUrl };
  if (typeof rec.label === "string" && rec.label.trim()) input.label = rec.label.trim();
  if (typeof rec.apiKey === "string" && rec.apiKey.trim()) input.apiKey = rec.apiKey.trim();
  if (contextWindow !== undefined) input.contextWindow = contextWindow;
  if (priority !== undefined) input.priority = priority;
  if (rpm !== undefined) input.rpm = rpm;
  if (parallel !== undefined) input.parallel = parallel;
  return input;
}

/** Mirror an active entry onto the legacy flat `provider` fields. */
function mirrorLegacy(config: AppConfig, entry: ProviderEntry): void {
  config.provider.type = entry.type;
  config.provider.baseUrl = entry.baseUrl;
  if (entry.apiKey !== undefined) config.provider.apiKey = entry.apiKey;
}

/**
 * Add or update a provider entry. Matching is by `label` (or `type` when no
 * label is given) against an entry's label/type. Returns the entry name.
 */
export function upsertProvider(config: AppConfig, input: ProviderInput): string {
  const provider = config.provider;
  const entries = Array.isArray(provider.entries) ? [...provider.entries] : [];
  const name = input.label || input.type;
  const idx = entries.findIndex((e) => (e.label || e.type) === name || e.type === name);

  const entry: ProviderEntry = idx >= 0 ? { ...entries[idx] } : { type: input.type, baseUrl: input.baseUrl };
  entry.type = input.type;
  entry.baseUrl = input.baseUrl;
  if (input.label !== undefined) entry.label = input.label;
  if (input.apiKey !== undefined) entry.apiKey = input.apiKey;
  if (input.contextWindow !== undefined) entry.contextWindow = input.contextWindow;
  if (input.priority !== undefined) entry.priority = input.priority;
  if (input.rpm !== undefined || input.parallel !== undefined) {
    const prev = entry.rateLimits ?? { maxRequestsPerMinute: 60, maxParallelTasks: 1 };
    entry.rateLimits = {
      maxRequestsPerMinute: input.rpm ?? prev.maxRequestsPerMinute,
      maxParallelTasks: input.parallel ?? prev.maxParallelTasks,
    };
  }

  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  config.provider.entries = entries;

  const active = provider.active || provider.type;
  if (!provider.active) config.provider.active = entry.label || entry.type;
  if ((entry.label || entry.type) === active || entries.length === 1) mirrorLegacy(config, entry);
  return entry.label || entry.type;
}

/** `POST /api/providers` — add/update, persist, reconfigure. */
export function handleProvidersPost(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
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
      const input = parseProviderInput(rec);
      if (!input) {
        sendJson(res, 400, { ok: false, error: "invalid-provider" });
        return;
      }
      const name = upsertProvider(config, input);
      const result = await persistAndReconfigure(s, config);
      sendJson(res, 200, { ok: true, name, ...buildProviderViews(config), ...result });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * Remove a provider entry. Refuses to delete the active provider (the caller
 * must switch first) so the agent never loses its live backend.
 */
export function removeProvider(config: AppConfig, name: string): "ok" | "active" | "missing" {
  const provider = config.provider;
  if (name === (provider.active || provider.type)) return "active";
  const entries = Array.isArray(provider.entries) ? provider.entries : [];
  const idx = entries.findIndex((e) => (e.label || e.type) === name || e.type === name);
  if (idx < 0) return "missing";
  config.provider.entries = entries.filter((_, i) => i !== idx);
  return "ok";
}

/** `DELETE /api/providers/:name` — remove, persist, reconfigure. */
export function handleProvidersDelete(res: ServerResponse, name: string, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  if (!name) {
    sendJson(res, 400, { ok: false, error: "invalid-name" });
    return;
  }
  const config = s.config;
  const outcome = removeProvider(config, name);
  if (outcome === "active") {
    sendJson(res, 409, { ok: false, error: "active-provider" });
    return;
  }
  if (outcome === "missing") {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  void persistAndReconfigure(s, config).then((result) => {
    sendJson(res, 200, { ok: true, ...buildProviderViews(config), ...result });
  });
}

/** Persist first, then reconfigure; neither failure is swallowed. */
async function persistAndReconfigure(
  s: WebUiState,
  config: AppConfig,
): Promise<{ persisted: boolean; warning?: string }> {
  let persisted = true;
  let warning: string | undefined;
  try {
    s.saveConfig?.(config);
  } catch {
    persisted = false;
    warning = "config not persisted";
  }
  if (s.reconfigure) {
    try {
      await s.reconfigure(config);
    } catch {
      warning = warning ? `${warning}; reconfigure failed` : "reconfigure failed";
    }
  }
  const out: { persisted: boolean; warning?: string } = { persisted };
  if (warning) out.warning = warning;
  return out;
}

/** Dispatch `/api/providers*`; returns whether the request was handled. */
export function handleProvidersApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  const p = reqUrl.pathname;
  if (p === "/api/providers" && req.method === "GET") {
    handleProvidersGet(res, s);
    return true;
  }
  if (p === "/api/providers" && req.method === "POST") {
    handleProvidersPost(req, res, s);
    return true;
  }
  if (p.startsWith("/api/providers/") && req.method === "DELETE") {
    handleProvidersDelete(res, decodeURIComponent(p.slice("/api/providers/".length)), s);
    return true;
  }
  return false;
}
