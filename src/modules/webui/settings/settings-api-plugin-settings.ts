// REST настроек одного плагина: подстраница = визуализация своего файла.
// Вынесено из `settings-api-plugins.ts` (правило 6): тумблер и каталог там,
// точечные `GET/PUT .../settings` — здесь.
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { broadcast } from "../state";
import { PluginSettingsStore } from "../../plugins/settings-store";
import type { SettingsState } from "./settings-api-write";

const SETTINGS_SUFFIX = "/settings";

/** Имя плагина из `param` (`<name>/settings`); null — не наша форма. */
function settingsName(param: string): string | null {
  if (!param.endsWith(SETTINGS_SUFFIX)) return null;
  const name = decodeURIComponent(param.slice(0, param.length - SETTINGS_SUFFIX.length));
  return name ? name : null;
}

/** Стор поверх менеджера; null — менеджер или `getPlugin` не провязаны. */
function storeOf(s: SettingsState): PluginSettingsStore | null {
  const plugins = s.plugins;
  if (!plugins || typeof plugins.getPlugin !== "function") return null;
  return new PluginSettingsStore((name) => plugins.getPlugin?.(name) ?? null);
}

/** Плагин неизвестен: `not_found`; схема/файл невозможны: `no_settings`. */
function settingsError(
  res: ServerResponse,
  store: PluginSettingsStore,
  name: string,
): void {
  if (!store.known(name)) sendJson(res, 404, { ok: false, error: "not_found" });
  else sendJson(res, 404, { ok: false, error: "no_settings" });
}

/**
 * `GET /api/plugins/:name/settings` — манифест + значения (секреты redacted).
 */
export function handlePluginSettingsGet(
  _req: IncomingMessage,
  res: ServerResponse,
  param: string,
  s: SettingsState,
): void {
  const name = settingsName(param);
  const store = s.plugins ? storeOf(s) : null;
  if (!s.plugins || !store) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return;
  }
  if (!name) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  const view = store.getView(name);
  if (!view) {
    settingsError(res, store, name);
    return;
  }
  sendJson(res, 200, { ok: true, name, ...view });
}

/**
 * `PUT /api/plugins/:name/settings {values}` — частичное обновление по схеме.
 */
export function handlePluginSettingsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  param: string,
  s: SettingsState,
): void {
  const name = settingsName(param);
  const store = s.plugins ? storeOf(s) : null;
  if (!s.plugins || !store) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return;
  }
  if (!name) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec || typeof rec.values !== "object" || rec.values === null) {
        sendJson(res, 400, { ok: false, error: "invalid-body" });
        return;
      }
      const out = store.update(name, rec.values as Record<string, unknown>);
      if ("error" in out) {
        if (out.error === "not_found") sendJson(res, 404, { ok: false, error: "not_found" });
        else if (out.error === "no_settings") {
          sendJson(res, 404, { ok: false, error: "no_settings" });
        } else sendJson(res, 400, { ok: false, error: out.error });
        return;
      }
      sendJson(res, 200, { ok: true, name, ...out });
      broadcast({ type: "plugins", ts: Date.now() }, s);
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}
