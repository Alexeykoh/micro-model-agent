/**
 * Проекция **дефиниций тулов** для egress (E1). Отдельная от `projectDeep`
 * (INV-DLP-9): слепая глубокая редакция правила имя тула и ключи JSON-схемы,
 * из-за чего провайдер отвечал 400 `Invalid 'tools[24].function.name'` (A11).
 *
 * Правила:
 * - `name` / `function.name` и ключи объектов — неприкосновенны (идентификаторы);
 * - редактируется только свободный текст (`description`, `title`);
 * - в схеме аргументов `enum`/`const`/`pattern`/`format`/`default` и имена
 *   свойств не трогаются: значение обязано оставаться валидным по схеме.
 */
import { projectText, type ProjectPolicy } from "./project";
import type { DataClass, EgressTokenRef } from "./types";

/** Накопитель редакции. */
interface Acc {
  changed: boolean;
  stats: Partial<Record<DataClass, number>>;
  tokens: EgressTokenRef[];
}

/** Ключи схемы, чьи значения — вложенные схемы (объект или массив схем). */
const SCHEMA_NODES = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
  "unevaluatedProperties",
  "dependentSchemas",
]);

/** Ключи схемы-карты: имена свойств неприкосновенны, значения — схемы. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/** Ключи, где содержимое — свободный текст, а не идентификатор. */
const FREE_TEXT_KEYS = new Set(["description", "title"]);

/** Поля дефиниции тула, содержащие JSON-схему аргументов. */
const TOOL_SCHEMA_KEYS = new Set([
  "parameters",
  "parametersJsonSchema",
  "input_schema",
  "inputSchema",
  "schema",
]);

/** Допустимое имя тула у OpenAI-совместимых провайдеров. */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

function projectString(text: string, policy: ProjectPolicy, acc: Acc): string {
  const r = projectText(text, policy);
  if (r.changed) acc.changed = true;
  for (const [k, n] of Object.entries(r.stats)) {
    acc.stats[k as DataClass] = (acc.stats[k as DataClass] ?? 0) + (n ?? 0);
  }
  acc.tokens.push(...r.tokens);
  return r.text;
}

/**
 * Спроецировать JSON-схему аргументов тула. Всё, что не описание и не
 * вложенная схема, сохраняется как есть — редакция не должна ломать валидность.
 */
function projectSchema(node: unknown, policy: ProjectPolicy, acc: Acc): unknown {
  if (Array.isArray(node)) return node.map((item) => projectSchema(item, policy, acc));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (FREE_TEXT_KEYS.has(key)) {
      out[key] = typeof value === "string" ? projectString(value, policy, acc) : value;
      continue;
    }
    if (SCHEMA_MAPS.has(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const map: Record<string, unknown> = {};
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
          map[prop] = projectSchema(sub, policy, acc);
        }
        out[key] = map;
      } else {
        out[key] = value;
      }
      continue;
    }
    if (SCHEMA_NODES.has(key)) {
      out[key] = projectSchema(value, policy, acc);
      continue;
    }
    // `enum`/`const`/`pattern`/`format`/`default`/`required`/… — без редакции.
    out[key] = value;
  }
  return out;
}

/** Спроецировать одну дефиницию тула (плоскую или OpenAI-совместимую). */
function projectToolNode(def: unknown, policy: ProjectPolicy, acc: Acc): unknown {
  if (!def || typeof def !== "object" || Array.isArray(def)) return def;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def as Record<string, unknown>)) {
    if (key === "function" && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = projectToolNode(value, policy, acc);
      continue;
    }
    if (FREE_TEXT_KEYS.has(key)) {
      out[key] = typeof value === "string" ? projectString(value, policy, acc) : value;
      continue;
    }
    if (TOOL_SCHEMA_KEYS.has(key)) {
      out[key] = projectSchema(value, policy, acc);
      continue;
    }
    // `name`, `type`, `strict`, … — идентификаторы, не текст для маскировки.
    out[key] = value;
  }
  return out;
}

/** Результат проекции массива дефиниций тулов. */
export interface ToolProjection<T> {
  tools: T[];
  changed: boolean;
  stats: Partial<Record<DataClass, number>>;
  tokens: EgressTokenRef[];
}

/**
 * Проекция массива дефиниций тулов (E1). Полиморфна по форме: плоская
 * `{name, description, parameters}` и OpenAI-совместимая
 * `{type, function: {name, description, parameters}}`.
 */
export function projectToolDefs<T>(tools: readonly T[], policy: ProjectPolicy): ToolProjection<T> {
  const acc: Acc = { changed: false, stats: {}, tokens: [] };
  const out = tools.map((tool) => projectToolNode(tool, policy, acc) as T);
  return { tools: out, changed: acc.changed, stats: acc.stats, tokens: acc.tokens };
}

/**
 * Защитный барьер: имя тула в результате проекции обязано совпадать с исходным.
 * Нарушение (будущий регресс проекции) восстанавливает исходное имя и отдаёт
 * причину для диагностики — битый запрос провайдеру не уходит.
 */
export function restoreToolNames<T>(
  original: readonly T[],
  projected: readonly T[],
): { tools: T[]; issues: string[] } {
  const issues: string[] = [];
  const tools = [...projected];
  const walk = (src: unknown, out: unknown, path: string): void => {
    if (!out || typeof out !== "object" || Array.isArray(out)) return;
    const before =
      src && typeof src === "object" && !Array.isArray(src)
        ? (src as Record<string, unknown>)
        : undefined;
    const rec = out as Record<string, unknown>;
    if (before && typeof before.name === "string" && typeof rec.name === "string") {
      if (rec.name !== before.name) {
        rec.name = before.name;
        issues.push(`${path || "tool"}.name: имя тула изменено проекцией — оставлено исходное`);
      }
    }
    const srcFn = before?.function;
    if (srcFn && typeof srcFn === "object" && rec.function && typeof rec.function === "object") {
      walk(srcFn, rec.function, `${path || "tool"}.function`);
    }
  };
  const n = Math.min(original.length, tools.length);
  for (let i = 0; i < n; i++) walk(original[i], tools[i], `tools[${i}]`);
  return { tools, issues };
}
