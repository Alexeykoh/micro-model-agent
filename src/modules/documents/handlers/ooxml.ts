/**
 * Общий OOXML-слой поверх ZIP (INV-D8): здесь и **только** здесь импортируется
 * `fast-xml-parser`. Даёт разбор XML и мелкие хелперы навигации по дереву;
 * специфика конкретных форматов (xlsx/docx/…) живёт в своих обработчиках.
 */
import { XMLParser } from "fast-xml-parser";
import { readZip, readZipText } from "./zip";

/**
 * `parseTagValue: false` — значения тегов остаются строками: для ячеек важны
 * ведущие нули и точность больших чисел, которые Number теряет. В брифе W2
 * перечислены четыре опции; пятая — обоснованное расширение (см. план W2a).
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  // trimValues режет крайние пробелы ячеек (теряя `xml:space="preserve"`) — осознанный
  // выбор для таблиц: в табличном контексте лишние пробелы по краям не значимы.
  trimValues: true,
});

/** Разбирает XML-строку в дерево (`@_`-префикс атрибутов, значения-строки). */
export function parseXml(text: string): unknown {
  return parser.parse(text);
}

/** Оборачивает значение в массив: `undefined` → `[]`, скаляр → `[v]`, массив → как есть. */
export function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Значение атрибута `@_<name>` узла как строка, либо `undefined`. */
export function attr(node: unknown, name: string): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return v === undefined || v === null ? undefined : String(v);
}

/** Простой текстовый узел как строка (скаляр, `#text` или пусто). */
export function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    return t === undefined ? "" : String(t);
  }
  return "";
}

/**
 * Склеивает текст узла в порядке ключей: собирает `t`/`#text` рекурсивно —
 * так rich-text `<si><r><t>He</t></r><r><t>llo</t></r></si>` даёт «Hello».
 */
export function collectText(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object") {
    let out = "";
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith("@_")) continue;
      if (key === "#text" || key === "t") out += typeof value === "string" ? value : collectText(value);
      else out += collectText(value);
    }
    return out;
  }
  return "";
}

/** OOXML-пакет: ZIP-карта + разбор XML-части по имени (`undefined`, если части нет). */
export interface Ooxml {
  zip: Map<string, Uint8Array>;
  xml(name: string): unknown;
}

/** Открывает OOXML-байты как ZIP и даёт разбор XML-частей по имени. */
export function readOoxml(bytes: Uint8Array): Ooxml {
  const zip = readZip(bytes);
  return {
    zip,
    xml(name: string): unknown {
      const text = readZipText(zip, name);
      return text === undefined ? undefined : parseXml(text);
    },
  };
}
