/**
 * Geo-форматы → `DocumentIR` (группа geo, INV-D2/D4/D5/D8).
 *
 * Поддержаны только `.geojson` и `.gpx`. Расширения `.json`/`.xml`/`.svg`
 * **намеренно не заявлены**: их обрабатывают `json.ts`/`xml.ts` (текстовая
 * группа). GPX разбирается через `ooxml.ts#parseXml` — прямой импорт
 * `fast-xml-parser` запрещён (INV-D8).
 *
 * Неразобранный документ → `meta.degraded` с причиной и сырым bounded-текстом
 * (INV-D5), без исключения.
 */
import { boundLine, boundText } from "../bound";
import { detectHead, type DocSource, type DocumentHandler, type ParseContext } from "../handler";
import { emptyIR, type DocumentIR } from "../ir";
import { child, findAll, parseXml, textOf } from "./ooxml";

/** Объект-JSON как словарь, иначе `undefined` (только безопасное сужение типа). */
function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Скаляр как непустая строка-подпись. */
function label(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Заголовок фичи: `properties.name ?? properties.title ?? id ?? "feature N"`. */
function featureTitle(feature: Record<string, unknown>, index: number): string {
  const props = obj(feature.properties);
  const named = label(child(props, "name")) ?? label(child(props, "title")) ?? label(feature.id);
  return named ?? `feature ${index + 1}`;
}

/** Добавляет bounded-узел outline на каждый узел `key` с заголовком из `<name>`. */
function pushGeoNodes(root: unknown, key: string, ir: DocumentIR, ctx: ParseContext): void {
  findAll(root, key).forEach((node, i) => {
    const name = textOf(child(node, "name")).trim();
    ir.outline.push({
      id: `${key}:${i}`,
      level: 1,
      title: boundLine(name || `${key} ${i + 1}`, ctx.limits),
      kind: "section",
    });
  });
}

/** GeoJSON → IR: узел outline на фичу FeatureCollection + code-блок JSON. */
export const geojsonHandler: DocumentHandler = {
  id: "geojson",
  group: "geo",
  extensions: [".geojson"],
  mediaTypes: ["application/geo+json"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const text = new TextDecoder().decode(bytes);
    const ir = emptyIR("geojson", bytes.length);
    ir.meta.title = source.display;
    try {
      const data: unknown = JSON.parse(text);
      const root = obj(data);
      if (root?.type === "FeatureCollection") {
        const features = Array.isArray(root.features) ? root.features : [];
        features.forEach((f, i) => {
          const feature = obj(f);
          const title = feature ? featureTitle(feature, i) : `feature ${i + 1}`;
          ir.outline.push({
            id: `f:${i}`,
            level: 1,
            title: boundLine(title, ctx.limits),
            kind: "section",
          });
        });
      }
      ir.blocks.push({
        kind: "code",
        lang: "json",
        text: boundText(JSON.stringify(data, null, 2), ctx.limits),
      });
    } catch (err) {
      ctx.logger.warn("documents: невалидный GeoJSON — деградированный разбор", {
        path: source.path,
        reason: err instanceof Error ? err.message : String(err),
      });
      ir.meta.degraded = { reason: "invalid GeoJSON — показан сырой текст" };
      ir.blocks.push({ kind: "code", lang: "json", text: boundText(text, ctx.limits) });
    }
    return ir;
  },
};

/** GPX → IR: узел outline на wpt/rte/trk + bounded code-блок XML. */
export const gpxHandler: DocumentHandler = {
  id: "gpx",
  group: "geo",
  extensions: [".gpx"],
  mediaTypes: ["application/gpx+xml"],
  detect: (h) => detectHead(h) === "unknown",
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const text = new TextDecoder().decode(bytes);
    const ir = emptyIR("gpx", bytes.length);
    ir.meta.title = source.display;
    let root: unknown;
    try {
      root = parseXml(text);
    } catch (err) {
      ctx.logger.warn("documents: невалидный GPX — деградированный разбор", {
        path: source.path,
        reason: err instanceof Error ? err.message : String(err),
      });
      root = undefined;
    }
    const gpx = child(root, "gpx");
    if (!obj(gpx)) {
      ir.meta.degraded = { reason: "invalid GPX — нет корня <gpx>" };
      ir.blocks.push({ kind: "code", lang: "xml", text: boundText(text, ctx.limits) });
      return ir;
    }
    pushGeoNodes(gpx, "wpt", ir, ctx);
    pushGeoNodes(gpx, "rte", ir, ctx);
    pushGeoNodes(gpx, "trk", ir, ctx);
    ir.blocks.push({ kind: "code", lang: "xml", text: boundText(text, ctx.limits) });
    return ir;
  },
};
