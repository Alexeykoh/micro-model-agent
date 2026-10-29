// Транспортные хелперы сервера `mma web` (auth, тела, JSON, ошибки).
// Оркестрация ходов (сабмиты, слоты, очереди, дренаж) — в `./turns`.
/**
 * Вынесены из `server.ts`, чтобы каждый файл был сильно меньше бюджета 300 строк
 * (правило #1). Чистая обвязка запрос/ответ — без переходов состояния приложения.
 */
import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errMsg } from "../../utils/error";
import { redactContextSecrets } from "../../core/api";
import { MAX_BODY_BYTES, bodyCapFor } from "./limits";
import { readEnv } from "../../config/env";

export { MAX_BODY_BYTES } from "./limits";

/** Жёсткий кап текста одного сообщения, независимый от капа тела транспорта. */
export const MAX_MESSAGE_CHARS = 32 * 1024;

/** Максимум картинок на сообщение (по дизайну ≤10). */
export const MAX_IMAGES = 10;

/** Максимум размера одного `data:image/...` URL: файл до 50 МБ после base64 (≈4/3) + заголовок. */
export const MAX_IMAGE_DATA_URL_BYTES = 70 * 1024 * 1024;

/** Бросается из readBody при превышении капа (маппится в HTTP 413). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

/** True для loopback-хостов. */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * True, если адрес peer'а — loopback (`127.0.0.0/8`, `::1`, IPv4-mapped).
 * Это клиент локального оператора, а не внешний API-клиент (спека 2026-10-20).
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Сравнение строк за константное время; разные длины коротко замыкаются (timingSafeEqual бросает). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Имя HttpOnly-куки, несущей веб-токен для GET-навигаций. */
const AUTH_COOKIE = "mma_web_auth";

/** Читает значение куки из сырого заголовка `Cookie:`; битые кодировки дают null. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Заголовки безопасности веб-поверхности (аудит §6.1): фрейминг, MIME-sniffing,
 * referrer и CSP.
 *
 * `script-src` содержит `'unsafe-inline'` — в `index.html` есть инлайновый
 * bootstrap темы; без него тема мигает при загрузке. Вынос скрипта в файл
 * позволит сузить политику — это `DEBT(webui-csp-inline-script)`.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Узкий срез состояния для auth-проверок: только токен. */
export interface AuthState {
  token: string | null | undefined;
}

/** Токен-auth HTTP-поверхностей (заголовок `x-mma-token`, `?token=` или кука); без токена — разрешено. */
export function checkAuth(req: IncomingMessage, reqUrl: URL, s: AuthState): boolean {
  if (!s.token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && safeEqual(header, s.token)) return true;
  const query = reqUrl.searchParams.get("token");
  if (query !== null && safeEqual(query, s.token)) return true;
  const cookie = cookieValue(req.headers.cookie, AUTH_COOKIE);
  return cookie !== null && safeEqual(cookie, s.token);
}

/**
 * Выдаёт браузеру same-site куку с токеном, чтобы plain-навигация
 * `<a target="_blank" href="/api/file?...">` (не умеющая ставить заголовок
 * `x-mma-token`) всё равно аутентифицировалась. `SameSite=Strict` — кросс-сайт
 * запрос её никогда не несёт, так что CSRF-поверхности не добавляется.
 */
export function setAuthCookie(res: ServerResponse, s: AuthState): void {
  if (!s.token) return;
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(s.token)}; Path=/; HttpOnly; SameSite=Strict`,
  );
}

/** Отклоняет кросс-доменные записи из браузера (CSRF-закалка). */
export function sameOrigin(req: IncomingMessage, reqUrl: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin GET
  try {
    return new URL(String(origin)).host === reqUrl.host;
  } catch {
    return false;
  }
}

/** Отправляет JSON-ответ со статусом. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Буферизует тело запроса до `cap`. На переполнении реджектит `BodyTooLargeError`
 * БЕЗ убийства сокета: вызывающий владеет ответом 413 и рвёт запрос только
 * после флаша ответа — иначе клиент получит socket error вместо 413.
 *
 * Кап — минимум из переданного и капа маршрута (`bodyCapFor`): маршруты
 * сообщений принимают большие тела (картинки), остальные — 1 МБ.
 */
export function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string> {
  const effectiveCap = Math.min(cap, bodyCapFor(req.method, requestPath(req)));
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    // Предпроверка Content-Length: не буферизовать тело, которое заведомо
    // больше капа (аудит §6.4).
    const declared = Number(req.headers?.["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > effectiveCap) {
      reject(new BodyTooLargeError());
      return;
    }
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > effectiveCap) {
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** Путь запроса без query-строки. */
function requestPath(req: IncomingMessage): string {
  const raw = req.url || "/";
  const idx = raw.indexOf("?");
  return idx >= 0 ? raw.slice(0, idx) : raw;
}

/** Достаёт `{ text, images }` из распарсенного тела; битый JSON и пусто — разные ошибки. */
export function parseMessageBody(
  raw: string,
): { text: string; images: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "invalid JSON" };
  }
  const rec =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const text = (typeof rec.text === "string" ? rec.text : "").slice(0, MAX_MESSAGE_CHARS);
  const rawImages = Array.isArray(rec.images) ? rec.images : [];
  if (rawImages.length > MAX_IMAGES) return { error: "too many images" };
  const images: string[] = [];
  for (const img of rawImages) {
    if (typeof img !== "string" || !img.startsWith("data:image/")) {
      return { error: "invalid image" };
    }
    if (Buffer.byteLength(img, "utf8") > MAX_IMAGE_DATA_URL_BYTES) {
      return { error: "image too large" };
    }
    images.push(img);
  }
  if (text.trim().length === 0 && images.length === 0) return { error: "empty" };
  return { text, images };
}

/**
 * Вычищает credentials из текста ошибки перед укладкой в SSE-пейлоад.
 * Переиспользует `redactContextSecrets` (точечная редактура) — общий
 * `sanitizeLogMessage` покалечил бы обычный текст, а веб-UI показывает их людям.
 */
export function scrubError(err: unknown): string {
  return redactContextSecrets(errMsg(err));
}

/**
 * Маппит ошибку запроса в ответ (аудит §6.6): переполнение тела — 413,
 * битый JSON — 400, таймаут — 504, всё прочее — 500 с вычищенным текстом.
 *
 * Раньше любой провал читался как 400 «bad request», и настоящая ошибка
 * сервера (провайдер не ответил, ФС отдала сбой) выглядела как ошибка клиента.
 */
export function requestError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    // Отвечаем 413 и **не** рвём сокет сразу: пока клиент дописывает тело,
    // `req.destroy()` уходит как RST, и fetch видит «socket connection closed»
    // вместо статуса (флейк в `webui-body-limits.test.ts`). Поэтому: ответ,
    // `Connection: close`, дренаж остатка тела, а destroy — только когда
    // ответ уже закрыт (или по таймауту-предохранителю).
    res.writeHead(413, {
      "Content-Type": "application/json; charset=utf-8",
      Connection: "close",
    });
    res.end(JSON.stringify({ error: "body too large" }));
    req.resume();
    const kill = setTimeout(() => req.destroy(), 2000);
    res.once("close", () => {
      clearTimeout(kill);
      req.destroy();
    });
    return;
  }
  if (err instanceof SyntaxError) {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }
  if (isTimeoutError(err)) {
    sendJson(res, 504, { error: "gateway timeout", detail: scrubError(err) });
    return;
  }
  sendJson(res, 500, { error: "internal error", detail: scrubError(err) });
}

/** Таймаут ли это (AbortError, ETIMEDOUT, «timeout» в имени/сообщении). */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (e.code === "ETIMEDOUT" || e.code === "UND_ERR_CONNECT_TIMEOUT") return true;
  return typeof e.message === "string" && /timeout|timed out/i.test(e.message);
}

/** Best-effort открытие UI в браузере по умолчанию (MMA_WEBUI_OPEN=0 отключает). */
export function tryOpenBrowser(url: string): void {
  if (readEnv("WEBUI_OPEN") === "0") return;
  try {
    const platform = process.platform;
    const cmd =
      platform === "win32"
        ? `start "" "${url}"`
        : platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    const child = exec(cmd, { windowsHide: true });
    child.unref?.();
  } catch {
    /* best-effort — открытие браузера не должно ломать старт */
  }
}
