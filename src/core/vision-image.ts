/**
 * Реализация core-шва подготовки vision-изображений. Живёт в ядре: модуль
 * документов получает порт через `src/core/api/**` и не импортирует `src/llm/*`
 * (INV-D7). Переиспользует уже существующий Bun Image-путь ресайза.
 */
import { prepareVisionImage } from "../llm/image-utils";
import type { ImageResizePort } from "./api/image-resize";

export const coreImageResize: ImageResizePort = {
  prepare(bytes, mime) {
    return prepareVisionImage(bytes, mime);
  },
};
