/**
 * Публичный порт ядра для подготовки vision-изображений (INV-3).
 * Модуль документов зависит только от этого контракта, не от `src/llm/*`.
 */

/** Результат подготовки растра к отправке в vision-контекст. */
export interface PreparedVisionImage {
  dataUrl: string;
  mime: string;
  /** Размер подготовленного изображения в байтах (после ресайза). */
  bytes: number;
  /** `true` — ресайз удался; `false` — отдан исходный data URL. */
  resized: boolean;
}

/** Ресайз + сборка data URL — инъекция в модуль вместо локального копирования. */
export interface ImageResizePort {
  prepare(bytes: Uint8Array, mime: string): Promise<PreparedVisionImage>;
}
