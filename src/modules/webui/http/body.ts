// Разбор JSON-тела POST-эндпоинтов `mma web`.
// Разбор — в нейтральном runtime-слое; чтение идёт через web-хелпер, чтобы
// сохранить кап маршрута (`bodyCapFor`).
import type { IncomingMessage } from "node:http";
import { readBody } from "../util";
import { parseJsonBody } from "../../../runtime/http-body";

export { parseJsonBody } from "../../../runtime/http-body";

/**
 * Читает тело запроса (до `cap`) и разбирает его как JSON.
 * `null` — не JSON.
 */
export function readJsonBody(
  req: IncomingMessage,
  cap: number,
): Promise<Record<string, unknown> | null> {
  return readBody(req, cap).then((raw) => parseJsonBody(raw));
}
