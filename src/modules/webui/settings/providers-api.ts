// REST-хендлеры страницы «Модель и провайдер»: add/update/delete записей, хот-свап агента.
// Вынесены из `settings-api.ts`. Секреты не эхом (`hasApiKey` вместо ключа).
// Auth и same-origin — выше в `server.ts`.
//
// Чистая запись (`upsertProvider`/`removeProvider`) и wire-вид живут в
// `runtime/providers-*` (split W11): те же операции исполняет демон.
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { persistAndReconfigure } from "../http/persist";
import { buildProviderViews } from "../../../runtime/providers-view";
import { parseProviderInput } from "../../../runtime/providers-input";
import { removeProvider, upsertProvider } from "../../../runtime/providers-write";
import type { ConfigStore, HttpTransport, SseTransport, RuntimeState } from "../state";

/** Парсинг входа живёт в runtime; реэкспорт для импортёров. */
export * from "../../../runtime/providers-input";
export * from "../../../runtime/providers-write";
export { buildProviderViews } from "../../../runtime/providers-view";

/** `GET /api/providers` — отредактированные записи + имя активного. */
export function handleProvidersGet(
  res: ServerResponse,
  s: ConfigStore & HttpTransport & SseTransport,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, buildProviderViews(s.config));
}

/** `POST /api/providers` — add/update, персист, reconfigure. */
export function handleProvidersPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & HttpTransport & SseTransport & RuntimeState,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  // Во время хода смена провайдера ломает живой раннер (аудит §7.9) — тот же
  // 409-гейт, что у /api/config.
  if (s.busy) {
    sendJson(res, 409, { ok: false, error: "busy" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const input = parseProviderInput(rec);
      if (!input) {
        sendJson(res, 400, { ok: false, error: "invalid-provider" });
        return;
      }
      const result = upsertProvider(config, input);
      if (!result.ok) {
        sendJson(res, 409, { ok: false, error: "name-conflict" });
        return;
      }
      const persisted = await persistAndReconfigure(s, config, "provider.active");
      sendJson(res, 200, {
        ok: true,
        name: result.name,
        ...buildProviderViews(config),
        ...persisted,
      });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/** `DELETE /api/providers/:name` — удалить, персист, reconfigure. */
export function handleProvidersDelete(
  res: ServerResponse,
  name: string,
  s: ConfigStore & HttpTransport & SseTransport,
): void {
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
  void persistAndReconfigure(s, config, "provider.active").then(
    (result) => {
      sendJson(res, 200, { ok: true, ...buildProviderViews(config), ...result });
    },
    () => {
      sendJson(res, 500, { ok: false, error: "delete_failed" });
    },
  );
}

/** Диспатч `/api/providers*`; возвращает, обработан ли запрос. */
export function handleProvidersApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: ConfigStore & HttpTransport & SseTransport & RuntimeState,
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
