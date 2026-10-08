/**
 * Транспортные хелперы HTTP-сервиса: JSON, Problem Details, bearer-auth, тело.
 * Тонкая обвязка request/response без переходов состояния приложения.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopback } from "../../webui/util";
import type { ProblemDetails } from "../runtime/problem";

export { isLoopback };

/** Отправляет JSON-ответ со статусом. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Отправляет Problem Details (`application/problem+json`) со статусом из объекта. */
export function sendProblem(res: ServerResponse, pd: ProblemDetails): void {
  res.writeHead(pd.status, { "Content-Type": "application/problem+json; charset=utf-8" });
  res.end(JSON.stringify(pd));
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
