/** MIME-политика картинок: что модель реально декодирует, и детект по байтам. */
import { extname } from "path";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/**
 * Форматы, которые реально декодирует vision-часть провайдеров (llama.cpp/mtmd
 * и облачные API): растровые. SVG/PDF и прочее векторное — не картинка для
 * модели: сервер ответит `400 Failed to load image or audio file`.
 *
 * Раньше неподдерживаемый файл молча подписывался `image/png` и уезжал в
 * историю — каждый следующий ход в сессии падал с 400.
 */
const MODEL_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** Ошибка «формат картинки не поддерживается моделью»: показываем человеку, а не в API. */
export class UnsupportedImageError extends Error {
  constructor(public readonly format: string) {
    super(
      `unsupported image format "${format}": the model accepts PNG, JPEG, WebP, GIF or BMP - convert the image first`,
    );
    this.name = "UnsupportedImageError";
  }
}

/**
 * MIME по магическим байтам: расширению и заголовку `data:` верить нельзя.
 * Возвращает undefined для всего, что не растровое (включая SVG).
 */
export function sniffImageMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return undefined;
}

/**
 * Сырой base64 data URL для растра, который не удалось перекодировать.
 * Бросает `UnsupportedImageError` вместо подмены MIME: неверный ярлык ломает
 * весь ход, и ошибка всплывает уже на стороне провайдера без контекста.
 */
export function rawRasterDataUrl(buf: Buffer, hint: string): string {
  const mime = sniffImageMime(buf);
  if (!mime || !MODEL_IMAGE_MIMES.has(mime)) {
    const ext = extname(hint.split("?")[0].split("#")[0]).toLowerCase().replace(/^\./, "");
    throw new UnsupportedImageError(ext || "unknown");
  }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Определяет MIME-тип по расширению файла.
 * @param filePath путь к файлу; @returns MIME-тип (дефолт image/png).
 */
export function detectMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "image/png";
}
