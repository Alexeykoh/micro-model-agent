/** Картинки: MIME, буфер обмена, загрузка файла/URL в data URL. */
import { readFileSync } from "fs";
import { extname } from "path";
import { fetchValidated } from "../modules/security/network-validator";
import type { NetworkSecurityConfig } from "../config/types";

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
 * Определяет MIME-тип по расширению файла.
 * @param filePath путь к файлу; @returns MIME-тип (дефолт image/png).
 */
export function detectMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "image/png";
}

/** Минимальная поверхность встроенного `Image` Bun (нет в @types/bun). */
interface BunImage {
  metadata(): Promise<{ width?: number }>;
  resize(width: number, height: number, opts?: { fit?: string }): BunImage;
  jpeg(opts?: { quality?: number }): BunImage;
  dataurl(): Promise<string>;
  buffer(): Promise<Uint8Array>;
}
type BunImageCtor = (new (buf: Buffer) => BunImage) & {
  fromClipboard(): BunImage | null;
};

/** Конструктор Bun.Image под Bun, иначе undefined. */
function getBunImage(): BunImageCtor | undefined {
  return (globalThis as { Bun?: { Image?: BunImageCtor } }).Bun?.Image;
}

/** Ужимает буфер в JPEG data URL через Bun.Image; null, если недоступно/упало. */
async function resizeToJpegDataUrl(buf: Buffer): Promise<string | null> {
  const Image = getBunImage();
  if (!Image) return null;
  try {
    const img = new Image(buf);
    const { width } = await img.metadata();
    const targetWidth = Math.min(800, width || 800);
    return await img.resize(targetWidth, 800, { fit: "inside" }).jpeg({ quality: 60 }).dataurl();
  } catch {
    return null;
  }
}

/**
 * Читает картинку из буфера обмена через Bun.Image (macOS/Windows).
 * На Linux — платформенные команды. Null, если картинки нет.
 * @returns буфер PNG/JPEG либо null.
 */
export async function readClipboardImage(): Promise<Buffer | null> {
  // Bun.Image.fromClipboard() работает на macOS и Windows
  const Image = getBunImage();
  if (Image) {
    try {
      const img = Image.fromClipboard();
      if (img) {
        const buf = await img.resize(800, 800, { fit: "inside" }).jpeg({ quality: 60 }).buffer();
        return Buffer.from(buf);
      }
    } catch {
      // Bun.Image.fromClipboard() упал — идём в платформенный фолбэк
    }
  }

  // Linux-фолбэк: xclip/wl-paste → временный файл → чтение
  return readClipboardFallback();
}

async function readClipboardFallback(): Promise<Buffer | null> {
  const { platform } = await import("os");
  const { execSync } = await import("child_process");
  const { readFileSync, unlinkSync } = await import("fs");
  const { join } = await import("path");

  if (platform() !== "linux") return null; // macOS/Windows use Bun.Image

  const tmpPath = join(process.env.TEMP || process.env.TMP || "/tmp", `mma-clip-${Date.now()}.png`);

  // Сначала Wayland (wl-paste), затем X11 (xclip)
  const commands = [
    `wl-paste --type image/png > "${tmpPath}" 2>/dev/null`,
    `xclip -selection clipboard -t image/png -o > "${tmpPath}" 2>/dev/null`,
  ];

  for (const cmd of commands) {
    try {
      execSync(cmd, { timeout: 5000 });
      const buf = readFileSync(tmpPath);
      unlinkSync(tmpPath);
      if (buf.length > 0) return buf;
    } catch {
      // пробуем следующую команду
    }
  }

  try {
    unlinkSync(tmpPath);
  } catch {
    // Best-effort чистка времянки — зависший файл не должен маскировать null.
  }
  return null;
}

/**
 * Грузит картинку из файла, ужимает через Bun.Image, отдаёт JPEG data URL.
 * Цель: ~800px по ширине, JPEG 60 — обычно 5–15KB (~2–4K токенов).
 */
export async function loadFileAsDataUrl(filePath: string): Promise<{ dataUrl: string }> {
  const buf = readFileSync(filePath);

  // Bun.Image, если есть — ресайз + конвертация в JPEG
  const resized = await resizeToJpegDataUrl(buf);
  if (resized) return { dataUrl: resized };

  // Фолбэк: сырой base64 (без ресайза)
  const b64 = buf.toString("base64");
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return { dataUrl: `data:${mime};base64,${b64}` };
}

/** Потолок загрузки картинки по URL (аудит §2.5): больше — ошибка, а не память. */
export const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Ошибка загрузки картинки: код различает «слишком большое» и прочее. */
export class ImageDownloadError extends Error {
  constructor(
    message: string,
    public readonly code: "response_too_large" | "http_error" | "network_error",
  ) {
    super(message);
    this.name = "ImageDownloadError";
  }
}

/**
 * Грузит картинку по URL, ужимает, отдаёт JPEG data URL.
 *
 * Загрузка идёт через `fetchValidated`: каждый хоп редиректа перепроверяется
 * против SSRF-политики (раньше обычный `fetch` тянул 302 на 127.0.0.1), есть
 * таймаут и потолок размера (аудит §2.5).
 */
export async function loadUrlAsDataUrl(
  url: string,
  opts: {
    securityConfig?: NetworkSecurityConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ dataUrl: string }> {
  let response: Response;
  try {
    const validated = await fetchValidated(
      url,
      opts.securityConfig,
      { signal: AbortSignal.timeout(15000) },
      opts.fetchImpl,
    );
    response = validated.response;
  } catch (err: any) {
    throw new ImageDownloadError(err?.message ?? "fetch failed", "network_error");
  }
  if (!response.ok) {
    throw new ImageDownloadError(
      `Failed to fetch image: ${response.status} ${response.statusText}`,
      "http_error",
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new ImageDownloadError(
      `Image too large: ${declared} bytes (limit ${MAX_IMAGE_DOWNLOAD_BYTES})`,
      "response_too_large",
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) {
    throw new ImageDownloadError(
      `Image too large: ${buf.byteLength} bytes (limit ${MAX_IMAGE_DOWNLOAD_BYTES})`,
      "response_too_large",
    );
  }

  const resized = await resizeToJpegDataUrl(buf);
  if (resized) return { dataUrl: resized };

  const b64 = buf.toString("base64");
  return { dataUrl: `data:image/png;base64,${b64}` };
}

/**
 * Превращает буфер обмена (уже ужатый readClipboardImage) в data URL.
 * Нужен обработчику Ctrl+V.
 */
export async function bufferToDataUrl(buf: Buffer): Promise<{ dataUrl: string }> {
  const resized = await resizeToJpegDataUrl(buf);
  if (resized) return { dataUrl: resized };

  const b64 = buf.toString("base64");
  return { dataUrl: `data:image/png;base64,${b64}` };
}
