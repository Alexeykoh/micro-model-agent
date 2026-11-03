/**
 * Общий конверт пишущих точек настроек: разбор тела, персист и `restartRequired`.
 * Вынесено из `settings-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import type { ConfigStore, WorkspaceStore, HttpTransport, SseTransport } from "../state";
import type { AppConfig } from "../../../config/types";

/** Состояние веб-сервера, которое видят REST-хендлеры настроек. */
export type SettingsState = ConfigStore & WorkspaceStore & HttpTransport & SseTransport;

export type ConfigWriteOutcome =
  | { ok: true; key?: string }
  | { ok: false; status: number; error: string };

/** Best-effort персист; бросающий `saveConfig` не должен стать 500-й. */
export function persistConfig(s: SettingsState, config: AppConfig, key?: string): boolean {
  try {
    s.saveConfig?.(config, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Общий конверт пишущих точек конфига: 503 без конфига, 400 на битом JSON,
 * затем чистая мутация. Успех персистится и флажит `restartRequired`
 * (MCP/LSP-соединения (пере-)поднимаются только на bootstrap).
 */
export function handleConfigWrite(
  req: IncomingMessage,
  res: ServerResponse,
  s: SettingsState,
  mutate: (config: AppConfig, body: Record<string, unknown>) => ConfigWriteOutcome,
  view: (config: AppConfig, state: SettingsState) => Record<string, unknown>,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const outcome = mutate(config, rec);
      if (!outcome.ok) {
        sendJson(res, outcome.status, { ok: false, error: outcome.error });
        return;
      }
      const persisted = persistConfig(s, config, outcome.key);
      sendJson(res, 200, { ok: true, persisted, restartRequired: true, ...view(config, s) });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}
