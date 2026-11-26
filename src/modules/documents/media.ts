/**
 * Медиа-хелперы потребителей документов (INV-D2/D7). Живут вне `handlers/`:
 * работают только с `DocumentIR` и байтами источника, не импортируют конкретный
 * обработчик и `src/llm/*`. Подготовку изображения (ресайз + data URL) отдаёт
 * core-шов `ImageResizePort` через `src/core/api/**`.
 */
import type { DocumentIR } from "./ir";

/**
 * Потолок байтов подготовленного растра для vision-контекста (INV-D4).
 * Проверяется после core-шва: всё, что осталось больше лимита, честно
 * отклоняется (`documents.image_too_large`), а не уходит гигантским payload'ом.
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

