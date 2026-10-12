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
import type { WebUiState } from "./state";
import { MAX_BODY_BYTES } from "./limits";
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

/** Токен-auth HTTP-поверхностей (заголовок `x-mma-token`, `?token=` или кука); без токена — разрешено. */
export function checkAuth(req: IncomingMessage, reqUrl: URL, s: WebUiState): boolean {
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
export function setAuthCookie(res: ServerResponse, s: WebUiState): void {
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
 */
export function readBody(req: IncomingMessage, cap = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > cap) {
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

/** Маппит провал чтения тела в ответ; переполненные получают flush-safe 413. */
export function readBodyError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    // Уничтожаем запрос только после флаша 413; убийство раньше —
    // и клиент видит socket error вместо статуса.
    res.end(JSON.stringify({ error: "body too large" }), () => req.destroy());
    return;
  }
  sendJson(res, 400, { error: "bad request" });
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
