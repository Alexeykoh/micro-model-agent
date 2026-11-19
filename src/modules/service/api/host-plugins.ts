/**
 * Плагины через host wire (split W4b-3 + W11): список, тумблер, reload и
 * настройки одного плагина.
 *
 * Форма ответов совпадает с web-панелью, поэтому адаптер отдаёт её как есть.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { setConfigValue } from "../../../config/registry";
import { PluginSettingsStore } from "../../plugins/settings-store";
import { mcpServersView } from "../../../runtime/mcp-view";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import type { AgentServiceState } from "../state";

const MAX_JSON_BYTES = 1024 * 1024;

/** `/v1/host/plugins*`, `/v1/host/reload/plugins`; `true` — обработан. */
export async function handleHostPlugins(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts[2] === "reload" && parts[3] === "plugins" && parts.length === 4) {
    if (req.method !== "POST") return false;
    return reload(res, s);
  }
  if (parts[2] !== "plugins") return false;

  if (parts.length === 3 && req.method === "GET") return list(res, s);
  if (parts.length === 4 && req.method === "POST") {
    return toggle(req, res, s, decodeURIComponent(parts[3]));
  }
  if (parts.length === 5 && parts[4] === "settings" && req.method === "GET") {
    return settingsGet(res, s, decodeURIComponent(parts[3]));
  }
  if (parts.length === 5 && parts[4] === "settings" && req.method === "PUT") {
    return settingsPut(req, res, s, decodeURIComponent(parts[3]));
  }
  return false;
}

/** `GET /v1/host/plugins` — записи, отказы, MCP-вид. */
function list(res: ServerResponse, s: AgentServiceState): boolean {
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

/** `POST /v1/host/plugins/:name {enabled}` — живой тумблер + persist deny-list. */
async function toggle(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  name: string,
): Promise<boolean> {
  const plugins = s.deps.plugins;
  if (!plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  if (typeof body.enabled !== "boolean") {
    sendJson(res, 400, { ok: false, error: "invalid-enabled" });
    return true;
  }
  const record = plugins.getRecords().find((p) => p.name === name);
  if (!record) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return true;
  }
  const enable = body.enabled;
  if (record.system && !enable) {
    sendJson(res, 409, { ok: false, error: "system" });
    return true;
  }
  const denied = new Set(s.config.plugins?.disabled ?? []);
  if (enable) denied.delete(name);
  else denied.add(name);
  const written = setConfigValue(s.config, "plugins.disabled", [...denied].join(","));
  if (!written.ok) {
    sendJson(res, 400, { ok: false, error: "invalid-value" });
    return true;
  }
  let persisted = true;
  try {
    s.deps.saveConfig?.(s.config);
  } catch {
    persisted = false;
  }
  plugins.setEnabled(name, enable);
  sendJson(res, 200, {
    ok: true,
    persisted,
    plugins: plugins.getRecords(),
    failures: plugins.getFailures(),
  });
  return true;
}

/** `POST /v1/host/reload/plugins` — перечитать плагины и навыки с диска. */
function reload(res: ServerResponse, s: AgentServiceState): boolean {
  const plugins = s.deps.plugins;
  if (!plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return true;
  }
  try {
    const report = plugins.reload();
    const skills = s.deps.skills?.reloadSources?.();
    sendJson(res, 200, {
      ok: true,
      plugins: plugins.getRecords(),
      failures: plugins.getFailures(),
      reload: { plugins: report, skills: skills ?? { added: 0, removed: 0 } },
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e) });
  }
  return true;
}

/** Стор настроек поверх живого менеджера; null — менеджер не умеет `getPlugin`. */
function storeOf(s: AgentServiceState): PluginSettingsStore | null {
  const plugins = s.deps.plugins;
  if (!plugins || typeof plugins.getPlugin !== "function") return null;
  return new PluginSettingsStore((name) => plugins.getPlugin?.(name) ?? null);
}

function settingsGet(
  res: ServerResponse,
  s: AgentServiceState,
  name: string,
): boolean {
  const store = storeOf(s);
  if (!store) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return true;
  }
  const view = store.getView(name);
  if (!view) {
    const error = store.known(name) ? "no_settings" : "not_found";
    sendJson(res, 404, { ok: false, error });
    return true;
  }
  sendJson(res, 200, { ok: true, name, ...view });
  return true;
}

async function settingsPut(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  name: string,
): Promise<boolean> {
  const store = storeOf(s);
  if (!store) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return true;
  }
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  if (typeof body.values !== "object" || body.values === null) {
    sendJson(res, 400, { ok: false, error: "invalid-body" });
    return true;
  }
  const out = store.update(name, body.values as Record<string, unknown>);
  if ("error" in out) {
    if (out.error === "not_found" || out.error === "no_settings") {
      sendJson(res, 404, { ok: false, error: out.error });
    } else {
      sendJson(res, 400, { ok: false, error: out.error });
    }
    return true;
  }
  sendJson(res, 200, { ok: true, name, ...out });
  return true;
}
