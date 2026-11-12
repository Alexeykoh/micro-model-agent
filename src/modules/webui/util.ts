// Транспортные хелперы сервера `mma web` (auth, тела, JSON, ошибки).
// Оркестрация ходов (сабмиты, слоты, очереди, дренаж) — в `./turns`.
/**
 * Вынесены из `server.ts`, чтобы каждый файл был сильно меньше бюджета 300 строк
 * (правило #1). Чистая обвязка запрос/ответ — без переходов состояния приложения.
 */
import { exec } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errMsg } from "../../utils/error";

export { checkAuth, sameOrigin, SECURITY_HEADERS, setAuthCookie } from "./auth";
export type { AuthState } from "./auth";
import { redactContextSecrets } from "../../core/api";
import type { ClientTz } from "../../core/prompt-facts";
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

/** JSON-ответ: статус + тело (единственный способ отдать JSON в webui). */
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

/** Разобранное тело POST /api/message: текст, картинки, опциональный пояс клиента. */
export type ParsedMessageBody =
  | { text: string; images: string[]; clientTz?: ClientTz }
  | { error: string };

/** Строгая проверка пояса: объект + непустая зона + `±HH:MM` (B18). */
function parseClientTz(value: unknown): ClientTz | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.timeZone !== "string" || !rec.timeZone) return undefined;
  if (typeof rec.utcOffset !== "string" || !/^[-+]\d{2}:\d{2}$/.test(rec.utcOffset)) return undefined;
  return { timeZone: rec.timeZone, utcOffset: rec.utcOffset };
}

/** Достаёт `{ text, images }` из распарсенного тела; битый JSON и пусто — разные ошибки. */
export function parseMessageBody(raw: string): ParsedMessageBody {
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
  // Пояс клиента — best-effort: кривой/отсутствующий молча игнорируем
  // (fail-open в серверное время), тело при этом валидно.
  const clientTz = parseClientTz(rec.clientTz);
  return clientTz ? { text, images, clientTz } : { text, images };
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
    // 413 без немедленного `req.destroy()`: пока клиент дописывает тело, destroy
    // уходит как RST и fetch видит «socket closed» вместо статуса (флейк
    // webui-body-limits). Дренаж + destroy после закрытия ответа.
    res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
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
