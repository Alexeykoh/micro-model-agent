// Статика веб-поверхности: карта роутов, auth, отдача файлов.
//
// Вынесено из `server.ts`: отдача статики — самостоятельный шов (вместе с
// auth-гейтом), а диспетчер запросов не растёт (правило 6 AGENTS).
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkAuth, sendJson, setAuthCookie } from "./util";
import type { WebUiAssets } from "./state";

/** Узкий срез состояния, который нужен статике: токен и источник ассетов. */
export interface StaticAuth {
  token: string | null | undefined;
  assetSource?: () => WebUiAssets;
}

/** Статические роуты, отдаваемые как есть (без шаблонной обработки). */
export const STATIC_ASSETS: Record<string, { type: string; key: keyof WebUiAssets }> = {
  "/index.html": { type: "text/html; charset=utf-8", key: "html" },
  "/styles.css": { type: "text/css; charset=utf-8", key: "css" },
  "/console.css": { type: "text/css; charset=utf-8", key: "cssConsole" },
  "/app.js": { type: "text/javascript; charset=utf-8", key: "js" },
  "/setup.js": { type: "text/javascript; charset=utf-8", key: "setupJs" },
  "/md.js": { type: "text/javascript; charset=utf-8", key: "mdJs" },
  "/smd.js": { type: "text/javascript; charset=utf-8", key: "smdJs" },
  "/hljs.js": { type: "text/javascript; charset=utf-8", key: "hljsJs" },
};

/**
 * Отдаёт статику (документ, стили, скрипты) — под тем же auth, что и API:
 * не-loopback бинд с токеном не должен отдавать UI без токена (аудит §6.2).
 *
 * @returns true, если запрос обслужен статикой.
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  assets: WebUiAssets,
  s: StaticAuth,
): boolean {
  const asset = STATIC_ASSETS[reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname];
  const isJsModule = reqUrl.pathname.endsWith(".js");
  if (!asset && !isJsModule) return false;

  if (!checkAuth(req, reqUrl, s)) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }
  // Кука с токеном — чтобы следующие запросы браузера (ассеты) прошли auth.
  setAuthCookie(res, s);

  // Перечитываем с диска, когда можно, чтобы правки ассетов цеплялись без
  // рестарта; `no-store` не даёт браузеру кешировать протухший UI. Фиксированный
  // снапшот из `startServer` — фолбэк (тесты, ошибки чтения).
  const src = s.assetSource ? s.assetSource() : assets;

  if (asset) {
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" });
    res.end(src[asset.key] ?? assets[asset.key] ?? "");
    return true;
  }

  // Разделённые фронтенд-модули: относительные ESM-импорты идут в `/js/*.js`
  // или топ-левел helper'ы (`/md-copy.js`) — отдаём любой `*.js` из карты.
  const key = reqUrl.pathname.slice(1);
  const body = src.jsModules?.[key] ?? assets.jsModules?.[key];
  if (body !== undefined) {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }
  return true;
}
