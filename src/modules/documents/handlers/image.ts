/**
 * Растровые изображения → `DocumentIR` (группа image, INV-D2/D5/D9).
 *
 * Текст не извлекается (OCR нет): обработчик отдаёт метаданные и один
 * `figure`-блок с `ref.kind:"raster"` и MIME. В контекст модели картинка
 * попадает только через vision-путь тула `document_read` (W4), а не строкой
 * base64 в тексте.
 *
 * `.svg` **намеренно не заявлен**: это векторный XML, его обрабатывает
 * `xml.ts` (текстовая группа). Здесь — только растровые форматы.
 */
import { boundLine } from "../bound";
import type { DocSource, DocumentHandler, ParseContext } from "../handler";
import { emptyIR } from "../ir";

/** Растровые MIME, которые модуль умеет распознать (INV-D5). */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp";

/** Расширение → MIME (маленькая локальная карта, INV-D9). */
const MIME: Record<string, ImageMime> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** MIME по расширению; неизвестное — нейтральный байтовый тип. */
function mimeFor(ext: string): ImageMime | "application/octet-stream" {
  return MIME[ext] ?? "application/octet-stream";
}

/** RIFF....WEBP: первые 4 байта RIFF, байты 8..11 — "WEBP". */
function isWebp(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return false;
  // `registry` передаёт только первые 8 байт — тогда доверяем RIFF + расширению.
  if (b.length < 12) return true;
  return b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
}

/** Magic-bytes растровых форматов (INV-D5: контент важнее расширения). */
function detectRaster(b: Uint8Array): { mime: ImageMime } | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { mime: "image/png" };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg" };
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { mime: "image/gif" };
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { mime: "image/bmp" };
  return isWebp(b) ? { mime: "image/webp" } : null;
}

/** Обработчик растровых изображений (группа image). */
export const imageHandler: DocumentHandler = {
  id: "image",
  group: "image",
  extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"],
  mediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"],
  detect: (h) => detectRaster(h) !== null,
  async parse(ctx: ParseContext, source: DocSource) {
    const bytes = await source.bytes();
    const fmt = source.ext.replace(".", "") || "image";
    const ir = emptyIR(fmt, bytes.length);
    ir.meta.title = source.display;
    // MIME — из magic-байтов; расширение лишь фолбэк (INV-D5, контент важнее имени).
    const mime = detectRaster(bytes)?.mime ?? mimeFor(source.ext);
    ir.blocks.push({
      kind: "figure",
      ref: { kind: "raster", mime, bytes: bytes.length, note: "raster" },
    });
    ir.outline.push({
      id: "fig:0",
      level: 1,
      title: boundLine(source.display, ctx.limits),
      kind: "section",
    });
    return ir;
  },
};
