/**
 * Медиа-хелперы потребителей документов (INV-D2/D7). Живут вне `handlers/`:
 * работают только с `DocumentIR` и байтами источника, не импортируют конкретный
 * обработчик. Data URL собирается через `node:buffer` — без `src/llm/*` (INV-D7).
 */
import { Buffer } from "node:buffer";
import type { DocumentIR } from "./ir";

/**
 * Потолок байтов растра, отправляемого в vision-контекст (INV-D4).
 * Модуль не умеет уменьшать изображение (INV-D7 запрещает `src/llm/*`), поэтому
 * всё, что больше, честно отклоняется (`documents.image_too_large`), а не
 * заваливает контекст гигантским payload'ом. См. DEBT(documents-vision-image-seam).
 */
export const MAX_VISION_BYTES = 5 * 1024 * 1024;

/**
 * MIME растровой фигуры, если `DocumentIR` — одиночное растровое изображение
 * (ровно один `figure`-блок с `ref.kind:"raster"`), иначе `null`.
 */
export function rasterMime(ir: DocumentIR): string | null {
  if (ir.blocks.length !== 1) return null;
  const [block] = ir.blocks;
  if (block.kind !== "figure" || block.ref.kind !== "raster") return null;
  return block.ref.mime;
}

/** Собирает `data:<mime>;base64,<...>` из байтов (INV-D7: без core-импортов). */
export function buildDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
