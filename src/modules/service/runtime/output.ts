/**
 * Structured output (спека §8.2): инструкция + парсинг + рантайм-валидация.
 *
 * Валидируем на стороне рантайма (defense-in-depth: локальные модели часто без
 * constrained decoding). Поддержано strict-подмножество JSON Schema: `type`,
 * `required`, `properties`, `items`, `enum`, `additionalProperties:false`.
 * Политика провала — один retry, затем `output_invalid` (не бесконечный retry).
 */
import { jsonrepair } from "jsonrepair";
import type { TaskOutputSpec } from "./task-registry";

/** Схема-подмножество, которую умеет валидатор. */
type Schema = Record<string, unknown>;

/** Итог валидации: успех либо первый сбой с человекочитаемым `detail`. */
type Validation = { ok: true } | { ok: false; detail: string };

/** Предикаты типов JSON Schema (карта вместо switch — меньше ветвлений). */
const TYPE_PREDICATES: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/** Инструкция модели: ровно один JSON-объект по схеме, без прозы/фенсов. */
export function buildOutputInstruction(output: TaskOutputSpec): string {
  const schema = output.schema ? JSON.stringify(output.schema) : "{}";
  return [
    "<system-summary>",
    "Respond with ONLY a single JSON object (no prose, no markdown fences).",
    "It MUST conform to this JSON Schema: every required field present and correctly typed.",
    `Schema: ${schema}`,
    "</system-summary>",
  ].join("\n");
}

/** Совпадает ли значение типу JSON Schema. */
function typeMatches(value: unknown, type: string): boolean {
  const predicate = TYPE_PREDICATES[type];
  return predicate ? predicate(value) : true;
}

/** `enum`-членство значения. `null` — ограничения нет/прошло. */
function validateEnum(value: unknown, s: Schema, path: string): Validation | null {
  if (!Array.isArray(s.enum)) return null;
  return s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
    ? null
    : { ok: false, detail: `${path}: value not in enum` };
}

/** Проверка обязательных полей объекта (`null` — «отсутствует», как в JSON Schema). */
function validateRequired(obj: Record<string, unknown>, s: Schema): Validation | null {
  if (!Array.isArray(s.required)) return null;
  for (const key of s.required as string[]) {
    if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
      return { ok: false, detail: `field \`${key}\` missing` };
    }
  }
  return null;
}

/** Проверка полей объекта против `properties` / `additionalProperties:false`. */
function validateProperties(
  obj: Record<string, unknown>,
  s: Schema,
  path: string,
): Validation | null {
  const props = (s.properties ?? {}) as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (props[key]) {
      const nested = validateAgainstSchema(val, props[key], `${path}.${key}`);
      if (!nested.ok) return nested;
      continue;
    }
    if (s.additionalProperties === false) {
      return { ok: false, detail: `${path}: unexpected field \`${key}\`` };
    }
  }
  return null;
}

/** Валидация объектной ветки: `required`, `properties`, `additionalProperties`. */
function validateObject(value: unknown, s: Schema, path: string): Validation | null {
  if (!typeMatches(value, "object")) return null;
  const obj = value as Record<string, unknown>;
  return validateRequired(obj, s) ?? validateProperties(obj, s, path);
}

/** Валидация массивной ветки: `items`. */
function validateArray(value: unknown, s: Schema, path: string): Validation | null {
  if (!typeMatches(value, "array") || !s.items) return null;
  const arr = value as unknown[];
  for (let i = 0; i < arr.length; i++) {
    const nested = validateAgainstSchema(arr[i], s.items, `${path}[${i}]`);
    if (!nested.ok) return nested;
  }
  return null;
}

/**
 * Валидирует значение против strict-подмножества схемы; первый сбой — detail.
 * Неизвестный `type` и `properties` без `type:"object"` — **ошибка схемы**, а
 * не молчаливый пропуск: иначе опечатка в схеме принимает любой ответ.
 */
export function validateAgainstSchema(value: unknown, schema: unknown, path = "$"): Validation {
  if (!schema || typeof schema !== "object") return { ok: true };
  const s = schema as Schema;
  if (typeof s.type === "string") {
    const predicate = TYPE_PREDICATES[s.type];
    if (!predicate) return { ok: false, detail: `${path}: schema error — unknown type "${s.type}"` };
    if (!predicate(value)) return { ok: false, detail: `${path}: expected ${s.type}` };
  } else if (s.properties !== undefined || s.required !== undefined) {
    return {
      ok: false,
      detail: `${path}: schema error — properties/required require type:"object"`,
    };
  }
  const failed = validateEnum(value, s, path) ?? validateObject(value, s, path) ?? validateArray(value, s, path);
  return failed ?? { ok: true };
}

/** Достаёт JSON из ответа: фенс ```json``` → сырой → первый `{…}` c repair. */
export function extractJson(text: string): unknown | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* пробуем repair/вырезку */
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(jsonrepair(candidate.slice(start, end + 1)));
    } catch {
      /* пробуем repair всего кандидата */
    }
  }
  try {
    return JSON.parse(jsonrepair(candidate));
  } catch {
    return undefined;
  }
}

/** Парсит и (при наличии схемы) валидирует структурированный ответ. */
export function parseStructured(
  text: string,
  output: TaskOutputSpec,
): { ok: true; data: unknown } | { ok: false; detail: string } {
  const data = extractJson(text);
  if (data === undefined) return { ok: false, detail: "response is not valid JSON" };
  if (output.schema) {
    const validation = validateAgainstSchema(data, output.schema);
    if (!validation.ok) return validation;
  }
  return { ok: true, data };
}
