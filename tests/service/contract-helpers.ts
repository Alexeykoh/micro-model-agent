/**
 * Проверка соответствия ответов сервиса объявленной OpenAPI-спецификации.
 *
 * Спека `mma serve` собирается вручную (`src/modules/service/openapi/`), поэтому
 * главный риск — её тихое расхождение с кодом: сменился код ответа, добавилось
 * поле, переехал enum. Здесь ответы сверяются со спекой в обе стороны:
 * «всё, что пришло, объявлено» и «всё, что объявлено обязательным, пришло».
 *
 * Валидатор — тот же strict-подмножество JSON Schema, которое сам рантайм
 * понимает для `output.schema` (`type`, `required`, `properties`, `items`,
 * `enum`, `additionalProperties`), плюс разрешение локальных `$ref`.
 */

import { get } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Схема произвольной формы (как в `openapi/schemas.ts`). */
type Schema = Record<string, unknown>;

/** Спецификация целиком (только те части, что нужны валидатору). */
export interface SpecLike {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, Schema> };
}

/** Результат сверки: чего не хватает и что не объявлено. */
export interface ShapeIssue {
  /** Обязательные поля схемы, которых нет в ответе. */
  missing: string[];
  /** Поля ответа, которых нет в схеме. */
  extra: string[];
}

/** Разрешает `$ref` на `#/components/schemas/<name>`. */
export function resolveRef(spec: SpecLike, schema: Schema): Schema {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = ref.split("/").pop() ?? "";
  const target = spec.components.schemas[name];
  if (!target) throw new Error(`dangling $ref: ${ref}`);
  return target;
}

/** Свойства объекта с учётом `$ref` и `allOf`-несовместимости (allOf не используем). */
function propertiesOf(spec: SpecLike, schema: Schema): Record<string, Schema> {
  const s = resolveRef(spec, schema);
  return (s.properties as Record<string, Schema>) ?? {};
}

/** Имена обязательных полей схемы с учётом `$ref`. */
function requiredOf(spec: SpecLike, schema: Schema): string[] {
  const s = resolveRef(spec, schema);
  return (s.required as string[]) ?? [];
}

/**
 * Сверяет объект ответа со схемой: обязательные поля на месте, лишних нет,
 * значения enums валидны, вложенные объекты/массивы проверены рекурсивно.
 */
export function checkShape(
  spec: SpecLike,
  value: unknown,
  schema: Schema,
  path = "$",
): ShapeIssue {
  if (value === null || typeof value !== "object") return { missing: [], extra: [] };
  return checkObject(spec, value, schema, path);
}

/** Проход по полям объекта: required + необъявленные + рекурсия вглубь. */
function checkObject(
  spec: SpecLike,
  value: object,
  schema: Schema,
  path: string,
): ShapeIssue {
  const resolved = resolveRef(spec, schema);
  const props = (resolved.properties as Record<string, Schema>) ?? {};
  let issue: ShapeIssue = { missing: [], extra: [] };

  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const missing = requiredOf(spec, resolved).filter((name) => record[name] === undefined);
    issue = { missing: missing.map((name) => `${path}.${name}`), extra: [] };
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    const sub = props[key];
    if (!sub) {
      // Не объявлено в схеме — это и есть расхождение (новое поле в коде).
      if (Object.keys(props).length > 0) issue.extra.push(`${path}.${key}`);
      continue;
    }
    issue = concat(issue, checkValue(spec, child, sub, `${path}.${key}`));
  }
  return issue;
}

/** Значение одного поля: enum → вложенный объект → массив → иначе пропуск. */
function checkValue(
  spec: SpecLike,
  value: unknown,
  schema: Schema,
  path: string,
): ShapeIssue {
  const resolved = resolveRef(spec, schema);
  const enumValues = resolved.enum as unknown[] | undefined;
  if (enumValues) {
    return enumValues.includes(value)
      ? { missing: [], extra: [] }
      : {
          missing: [],
          extra: [`${path}=${JSON.stringify(value)} (не в enum ${JSON.stringify(enumValues)})`],
        };
  }
  if (resolved.type === "array" && Array.isArray(value)) {
    return checkArray(spec, value, resolved.items as Schema | undefined, path);
  }
  if (resolved.properties) return checkObject(spec, value as object, schema, path);
  return { missing: [], extra: [] };
}

/** Элементы массива против `items`. */
function checkArray(
  spec: SpecLike,
  items: unknown[],
  itemSchema: Schema | undefined,
  path: string,
): ShapeIssue {
  let issue: ShapeIssue = { missing: [], extra: [] };
  if (!itemSchema) return issue;
  items.forEach((item, i) => {
    issue = concat(issue, checkValue(spec, item, itemSchema, `${path}[${i}]`));
  });
  return issue;
}

/** Склейка расхождений вложенного уровня. */
function concat(a: ShapeIssue, b: ShapeIssue): ShapeIssue {
  return { missing: [...a.missing, ...b.missing], extra: [...a.extra, ...b.extra] };
}

/** Схема успешного JSON-ответа операции (по коду статуса). */
export function successSchema(
  spec: SpecLike,
  method: string,
  path: string,
  status: string,
): Schema | undefined {
  const op = spec.paths[path]?.[method];
  const responses = op?.responses as Record<string, { content?: Record<string, { schema: Schema }> }>;
  const content = responses?.[status]?.content?.["application/json"];
  return content?.schema;
}

/** Коды ответов, объявленные в спеке для операции. */
export function declaredStatuses(spec: SpecLike, method: string, path: string): string[] {
  const op = spec.paths[path]?.[method];
  const responses = op?.responses as Record<string, unknown> | undefined;
  return responses ? Object.keys(responses) : [];
}

/** Операция объявлена открытой (`security: []`), т.е. без bearer. */
export function isOpenOperation(spec: SpecLike, method: string, path: string): boolean {
  const op = spec.paths[path]?.[method];
  if (!op) return false;
  const security = op.security as unknown[] | undefined;
  return Array.isArray(security) && security.length === 0;
}

/** Заголовки, объявленные в спеке для ответа (`headers: {Name: {description}}`). */
export function declaredHeaders(
  spec: SpecLike,
  method: string,
  path: string,
  status: string,
): string[] {
  const op = spec.paths[path]?.[method];
  const responses = op?.responses as Record<string, { headers?: Record<string, unknown> }>;
  return Object.keys(responses?.[status]?.headers ?? {});
}

/** Один разобранный SSE-кадр (`id:` / `event:` / `data:`). */
export interface SseFrame {
  id: string;
  event: string;
  data: string;
}

/**
 * Открывает SSE-поток сессии, выполняет `during` и возвращает разобранные кадры.
 * Поток закрывается сам — иначе тест оставит висящий сокет.
 */
export function captureSse(
  url: string,
  sessionId: string,
  headers: Record<string, string>,
  during: () => Promise<void>,
): Promise<SseFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    let buf = "";
    const request = get(
      `${url}/v1/sessions/${sessionId}/events`,
      { headers },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx = buf.indexOf("\n\n");
          while (idx !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const frame = parseFrame(raw);
            if (frame) frames.push(frame);
            idx = buf.indexOf("\n\n");
          }
        });
        res.on("error", () => {
          /* поток закрыт нами же */
        });
      },
    );
    request.on("error", reject);
    void during().then(() => {
      setTimeout(() => {
        request.destroy();
        resolve(frames);
      }, 150);
    }, reject);
  });
}

/** Разбирает один SSE-кадр; keep-alive комментарии и пустые блоки — пропуск. */
function parseFrame(raw: string): SseFrame | undefined {
  let id = "";
  let event = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return data ? { id, event, data } : undefined;
}
/** Типы событий, объявленные в enum `EventEnvelope.type`. */
export function declaredEventTypes(spec: SpecLike): string[] {
  const schema = spec.components.schemas.EventEnvelope as {
    properties: { type: { enum: string[] } };
  };
  return schema.properties.type.enum;
}

/**
 * Типы событий, которые рантайм реально эмитит: литералы в вызовах
 * `emitEvent(state, task, "type", …)` и `opts.emit("type", …)` по исходникам.
 * Статический разбор — сознательно: он ловит тип в коде, который не внесли в
 * контракт, и запись в контракте, под которую никто не эмитит.
 */
export function emittedEventTypes(serviceDir: string): string[] {
  const files = [
    "runtime/event-bridge.ts",
    "runtime/prompt-io.ts",
    "api/tasks-api.ts",
  ];
  const found = new Set<string>();
  const patterns = [/emitEvent\([^,]+,[^,]+,\s*"([a-z._]+)"/g, /opts\.emit\(\s*"([a-z._]+)"/g];
  for (const rel of files) {
    const src = readFileSync(join(serviceDir, rel), "utf8");
    for (const pattern of patterns) {
      for (const match of src.matchAll(pattern)) found.add(match[1]);
    }
  }
  return [...found].sort();
}