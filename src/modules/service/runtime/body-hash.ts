/**
 * Канонический JSON и хэш тела сабмита для `Idempotency-Key`.
 *
 * Порядок ключей в объекте не должен менять Identity запроса: повтор того же
 * тела, отправленного другим сериализатором, обязан попадать в hit, а не в
 * `409`. Поэтому хэшируем канонический вид (сортировка ключей), а не сырой
 * `JSON.stringify(body)`.
 */
import { createHash } from "node:crypto";

/** Канонический JSON: ключи объектов отсортированы, значения — рекурсивно. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const fields = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 (hex) канонического тела. */
export function hashBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}
