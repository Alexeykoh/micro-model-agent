import { readFileSync } from "fs";
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

/** Detect MIME type from file extension. */
export function detectMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "image/png";
}

/** Minimal surface of Bun's built-in `Image` (not in @types/bun). */
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

/** The Bun.Image constructor when running under Bun, else undefined. */
function getBunImage(): BunImageCtor | undefined {
  return (globalThis as { Bun?: { Image?: BunImageCtor } }).Bun?.Image;
}

/** Downscale a buffer to a JPEG data URL via Bun.Image; null when unavailable/failed. */
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
 * Read image from system clipboard using Bun.Image (macOS/Windows).
 * Falls back to platform-specific commands on Linux.
 * Returns null if clipboard has no image.
 */
export async function readClipboardImage(): Promise<Buffer | null> {
  // Bun.Image.fromClipboard() works on macOS and Windows
  const Image = getBunImage();
  if (Image) {
    try {
      const img = Image.fromClipboard();
      if (img) {
        const buf = await img.resize(800, 800, { fit: "inside" }).jpeg({ quality: 60 }).buffer();
        return Buffer.from(buf);
      }
    } catch {
      // Bun.Image.fromClipboard() failed — fall through to platform fallback
    }
  }

  // Linux fallback: xclip/wl-paste → temp file → read
  return readClipboardFallback();
}

async function readClipboardFallback(): Promise<Buffer | null> {
  const { platform } = await import("os");
  const { execSync } = await import("child_process");
  const { readFileSync, unlinkSync } = await import("fs");
  const { join } = await import("path");

  if (platform() !== "linux") return null; // macOS/Windows use Bun.Image

  const tmpPath = join(process.env.TEMP || process.env.TMP || "/tmp", `mma-clip-${Date.now()}.png`);

  // Try Wayland (wl-paste) first, then X11 (xclip)
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
      // try next command
    }
  }

  try {
    unlinkSync(tmpPath);
  } catch {
    // Best-effort temp cleanup — a leftover temp file must not mask the null.
  }
  return null;
}

/**
 * Load an image from a file path, resize via Bun.Image, return as JPEG data URL.
 * Target: ~800px wide, JPEG quality 60 — typically 5-15KB (~2-4K tokens).
 */
export async function loadFileAsDataUrl(filePath: string): Promise<{ dataUrl: string }> {
  const buf = readFileSync(filePath);

  // Use Bun.Image if available — resize + convert to JPEG
  const resized = await resizeToJpegDataUrl(buf);
  if (resized) return { dataUrl: resized };

  // Fallback: raw base64 (no resize)
  const b64 = buf.toString("base64");
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return { dataUrl: `data:${mime};base64,${b64}` };
}

/**
 * Load an image from a URL, resize, return as JPEG data URL.
 */
export async function loadUrlAsDataUrl(url: string): Promise<{ dataUrl: string }> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  const resized = await resizeToJpegDataUrl(buf);
  if (resized) return { dataUrl: resized };

  const b64 = buf.toString("base64");
  return { dataUrl: `data:image/png;base64,${b64}` };
}

/**
 * Process a clipboard buffer (already resized by readClipboardImage)
 * into a data URL. Used by Ctrl+V handler.
 */
export async function bufferToDataUrl(buf: Buffer): Promise<{ dataUrl: string }> {
  const resized = await resizeToJpegDataUrl(buf);
  if (resized) return { dataUrl: resized };

  const b64 = buf.toString("base64");
  return { dataUrl: `data:image/png;base64,${b64}` };
}
