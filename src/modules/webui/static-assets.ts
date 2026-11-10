// Статика веб-поверхности: карта роутов, auth, отдача файлов.
//
// Вынесено из `server.ts`: отдача статики — самостоятельный шов (вместе с
// auth-гейтом), а диспетчер запросов не растёт (правило 6 AGENTS).
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkAuth, sendJson, setAuthCookie } from "./util";
import type { WebUiAssets } from "./state";

/** Узкий срез состояния, который нужен статике: токен, источник ассетов, ETag. */
export interface StaticAuth {
  token: string | null | undefined;
  assetSource?: () => WebUiAssets;
  assetEtag?: () => string | undefined;
}

/**
 * Ключи `WebUiAssets`, которые отдаются как есть (карта роутов не использует
 * `jsModules` — у него ключи-пути, а не имена полей).
 */
export type StaticAssetKey =
  | "html"
  | "css"
  | "cssConsole"
  | "cssGroovebox"
  | "cssMetallica"
  | "metallicaCover"
  | "metallicaLogo"
  | "cssThemes"
  | "js"
  | "setupJs"
  | "mdJs"
  | "smdJs"
  | "hljsJs";

/** Статические роуты, отдаваемые как есть (без шаблонной обработки). */
export const STATIC_ASSETS: Record<string, { type: string; key: StaticAssetKey }> = {
  "/index.html": { type: "text/html; charset=utf-8", key: "html" },
  "/styles.css": { type: "text/css; charset=utf-8", key: "css" },
  "/console.css": { type: "text/css; charset=utf-8", key: "cssConsole" },
  "/groovebox.css": { type: "text/css; charset=utf-8", key: "cssGroovebox" },
  "/metallica.css": { type: "text/css; charset=utf-8", key: "cssMetallica" },
  "/metallica-cover.svg": { type: "image/svg+xml; charset=utf-8", key: "metallicaCover" },
  "/metallica-logo.svg": { type: "image/svg+xml; charset=utf-8", key: "metallicaLogo" },
  "/themes.css": { type: "text/css; charset=utf-8", key: "cssThemes" },
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

  // Снапшот из кеша; фиксированный снапшот из `startServer` — фолбэк
  // (тесты, ошибки чтения). `no-cache` + ETag: браузер перепроверяет документ
  // и на совпадении получает `304` без тела — правки ассетов цепляются
  // без рестарта, повторная загрузка страницы не тащит 174 файла заново.
  const src = s.assetSource ? s.assetSource() : assets;
  const etag = s.assetEtag?.();

  if (asset) {
    sendAsset(req, res, asset.type, src[asset.key] ?? assets[asset.key] ?? "", etag);
    return true;
  }

  // Разделённые фронтенд-модули: относительные ESM-импорты идут в `/js/*.js`
  // или топ-левел helper'ы (`/md-copy.js`) — отдаём любой `*.js` из карты.
  const key = reqUrl.pathname.slice(1);
  const body = src.jsModules?.[key] ?? assets.jsModules?.[key];
  if (body !== undefined) {
    sendAsset(req, res, "text/javascript; charset=utf-8", body, etag);
    return true;
  }

  // INV-W2: неизвестный модуль — явный 404. Раньше ветка возвращала `true`
  // без `res.end()`: запрос висел до таймаута браузера и подвешивал boot-граф.
  sendJson(res, 404, { error: "not found", path: reqUrl.pathname });
  return true;
}

/** `Cache-Control` статики: без таймаута кеша, но с обязательной перепроверкой. */
const NO_CACHE = "no-cache";

/**
 * Отдаёт ассет: `304` на совпадение `If-None-Match`, иначе `200` с телом.
 * ETag опционален (нет отпечатка дерева — нет и `304`).
 */
function sendAsset(
  req: IncomingMessage,
  res: ServerResponse,
  type: string,
  body: string,
  etag?: string,
): void {
  const raw = req.headers["if-none-match"];
  const ifNoneMatch = Array.isArray(raw) ? raw.join(",") : raw;
  if (etag && ifNoneMatch?.split(",").some((v) => v.trim() === etag)) {
    res.writeHead(304, { ETag: etag, "Cache-Control": NO_CACHE });
    res.end();
    return;
  }
  const headers: Record<string, string> = { "Content-Type": type, "Cache-Control": NO_CACHE };
  if (etag) headers.ETag = etag;
  res.writeHead(200, headers);
  res.end(body);
}
