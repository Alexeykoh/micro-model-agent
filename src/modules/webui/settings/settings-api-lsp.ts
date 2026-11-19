/**
 * REST-хендлеры LSP-таблицы. Чистые операции и типы — в
 * `runtime/lsp-settings` (split W11): те же использует демон.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util";
import { listLspServers, updateLspServer } from "../../../runtime/lsp-settings";
import { handleConfigWrite, type SettingsState } from "./settings-api-write";

export * from "../../../runtime/lsp-settings";

/** `GET /api/lsp` — таблица LSP-серверов. */
export function handleLspGet(res: ServerResponse, s: SettingsState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, { servers: listLspServers(s.config) });
}

/** `PUT /api/lsp/:lang {enabled?,timeout?,command?,args?}` — правит один LSP-сервер. */
export function handleLspUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  lang: string,
  s: SettingsState,
): void {
  handleConfigWrite(
    req,
    res,
    s,
    (config, rec) => {
      const result = updateLspServer(config, lang, rec);
      if (result.ok) return { ok: true, key: "lsp" };
      return { ok: false, status: result.error === "not_found" ? 404 : 400, error: result.error };
    },
    (config) => ({ servers: listLspServers(config) }),
  );
}
