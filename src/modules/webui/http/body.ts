// Единый парсер JSON-тела для POST-хендлеров `mma web`.
/**
 * Раньше каждая POST-точка повторяла тот же try/catch `JSON.parse` плюс сужение
 * до объекта (~12 мест). Контракт поведения, сохраняется точь-в-точь:
 * - битый JSON → `null` (вызывающий отвечает 400 `invalid JSON`);
 * - валидный JSON-не-объект (напр. `"str"`, `42`) → `{}`, чтобы собственная
 *   валидация точки отвергла его своей специфичной ошибкой;
 * - транспортные ошибки (переполнение, сокет) по-прежнему реджектятся и
 *   маппятся через `readBodyError`.
 */
import type { IncomingMessage } from "node:http";
import { readBody } from "../util";

/** Парсит сырое тело; `null` — битый JSON. Не бросает. */
export function parseJsonBody(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Читает тело запроса (до `cap`) и парсит как JSON.
 * Резолвится в `null` на битом JSON; транспортные ошибки реджектятся.
 */
export function readJsonBody(
  req: IncomingMessage,
  cap: number,
): Promise<Record<string, unknown> | null> {
  return readBody(req, cap).then((raw) => parseJsonBody(raw));
}
