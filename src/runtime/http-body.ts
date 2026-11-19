// Чтение и разбор HTTP-тела: общий runtime-слой для `mma web` и `mma serve`.
/**
 * Капом владеет вызывающий: webui дополнительно ограничивает тело по маршруту
 * (`bodyCapFor`), сервис передаёт свой `MAX_JSON_BYTES`. Здесь только механика
 * буферизации и разбора, без знания о маршрутах.
 */
import type { IncomingMessage } from "node:http";

/**
 * Жёсткий максимум тела сообщения. 10 картинок по 50 МБ после base64
 * (≈4/3) плюс заголовки — около 768 МБ.
 */
export const MAX_BODY_BYTES = 768 * 1024 * 1024;

/** Дефолтный кап для обычных JSON-запросов (1 МБ). */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Бросается из readBody при превышении капа (маппится в HTTP 413). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
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
    // Предпроверка Content-Length: не буферизовать тело, которое заведомо
    // больше капа (аудит §6.4).
    const declared = Number(req.headers?.["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > cap) {
      reject(new BodyTooLargeError());
      return;
    }
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

/** Разбор тела; `null` — битый JSON. Не-объект приводится к `{}`. */
export function parseJsonBody(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/**
 * Читает тело запроса (до `cap`) и разбирает его как JSON.
 * `null` — не JSON; исключение чтения пробрасывается (413/400 решает вызывающий).
 */
export function readJsonBody(
  req: IncomingMessage,
  cap: number,
): Promise<Record<string, unknown> | null> {
  return readBody(req, cap).then((raw) => parseJsonBody(raw));
}
