/**
 * Транспортные хелперы HTTP-сервиса: JSON, Problem Details, bearer-auth, тело.
 * Тонкая обвязка request/response без переходов состояния приложения.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyTooLargeError, parseJsonBody, readBody } from "../../../runtime/http-body";
import { isLoopback } from "../../../runtime/net";
import type { ProblemDetails } from "../runtime/problem";
import { problem } from "../runtime/problem";

export { isLoopback };

/** Отправляет JSON-ответ со статусом. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Отправляет Problem Details (`application/problem+json`) со статусом из объекта.
 * `onSent` выполняется после флаша — им рвутся запросы с непрочитанным телом
 * (иначе клиент видит socket error вместо 413).
 */
export function sendProblem(
  res: ServerResponse,
  pd: ProblemDetails,
  onSent?: () => void,
): void {
  res.writeHead(pd.status, { "Content-Type": "application/problem+json; charset=utf-8" });
  res.end(JSON.stringify(pd), onSent);
}

/**
 * Читает JSON-тело, превращая провал чтения в Problem Details: переполнение →
 * `413`, битый JSON/обрыв → `400 invalid JSON`. Возвращает `undefined`, когда
 * ответ уже отправлен — вызывающий обязан выйти.
 *
 * Без этого реджект из `readBody` улетал бы из хендлера в диспатчер, и
 * интегратор получал бы обрыв сокета вместо кода ответа (а в Node — ещё и
 * unhandled rejection, который валит процесс на очереди). Битый JSON раньше
 * превращался в `{}`: клиент получал ложное «input required» вместо «bad JSON».
 */
export async function readJsonBodyOrProblem(
  req: IncomingMessage,
  res: ServerResponse,
  cap: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readBody(req, cap);
    // Пустое тело — отсутствие полей (`{}`): у точек со всеми опциональными
    // полями это валидно, `null` здесь врал бы («invalid JSON» на пустой POST).
    if (!raw.trim()) return {};
    const parsed = parseJsonBody(raw);
    if (parsed === null) {
      sendProblem(
        res,
        problem({
          type: "validation",
          title: "invalid JSON",
          status: 400,
          detail: "request body is not valid JSON",
        }),
        () => req.destroy(),
      );
      return undefined;
    }
    return parsed;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendProblem(
        res,
        problem({
          type: "validation",
          title: "request body too large",
          status: 413,
          detail: `limit is ${cap} bytes`,
        }),
        () => req.destroy(),
      );
      return undefined;
    }
    sendProblem(
      res,
      problem({ type: "validation", title: "could not read request body", status: 400 }),
      () => req.destroy(),
    );
    return undefined;
  }
}

/** Сравнение за константное время (разные длины коротко замыкаются). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Проверяет `Authorization: Bearer <token>`. Без токена (loopback-режим) —
 * разрешено. Тенант-контекст резолвится из auth, не из тела (спека §11).
 */
export function bearerOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return safeEqual(match[1].trim(), token);
}
