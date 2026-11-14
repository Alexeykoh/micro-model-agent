/**
 * Чтение картинки из буфера обмена в data-URL (split W9).
 *
 * Общий шаг для локального REPL и thin-клиента: сам клипборд и кодирование —
 * платформенный код в `llm/image-utils`, а решение «куда деть картинку»
 * остаётся у поверхности (локально — `addPendingImage`, по wire — `submit`).
 */
export async function readClipboardDataUrl(): Promise<string | null> {
  const { readClipboardImage, bufferToDataUrl } = await import("../llm/image-utils");
  const clipBuf = await readClipboardImage();
  if (!clipBuf) return null;
  const { dataUrl } = await bufferToDataUrl(clipBuf);
  return dataUrl;
}

/** Размер data-URL в килобайтах — для строки «прикреплено». */
export function dataUrlSizeKb(dataUrl: string): number {
  return Math.round((dataUrl.length * 3) / 4 / 1024);
}
