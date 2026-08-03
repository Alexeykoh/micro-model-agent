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

/**
 * Read image from system clipboard using Bun.Image (macOS/Windows).
 * Falls back to platform-specific commands on Linux.
 * Returns null if clipboard has no image.
 */
export async function readClipboardImage(): Promise<Buffer | null> {
  // Bun.Image.fromClipboard() works on macOS and Windows
  if (typeof Bun !== "undefined" && typeof (Bun as any).Image !== "undefined") {
    try {
      const img = (Bun as any).Image.fromClipboard();
      if (img) {
        const buf = await img
          .resize(800, 800, { fit: "inside" })
          .jpeg({ quality: 60 })
          .buffer();
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

  const tmpPath = join(
    process.env.TEMP || process.env.TMP || "/tmp",
    `mma-clip-${Date.now()}.png`,
  );

  try {
    if (platform() === "linux") {
      execSync(
        `xclip -selection clipboard -t image/png -o > "${tmpPath}" 2>/dev/null`,
        { timeout: 5000 },
      );
    } else {
      return null; // macOS/Windows should use Bun.Image
    }

    const buf = readFileSync(tmpPath);
    unlinkSync(tmpPath);
    return buf.length > 0 ? buf : null;
  } catch {
    try { unlinkSync(tmpPath); } catch {}
    return null;
  }
}

/**
 * Load an image from a file path, resize via Bun.Image, return as JPEG data URL.
 * Target: ~800px wide, JPEG quality 60 — typically 5-15KB (~2-4K tokens).
 */
export async function loadFileAsDataUrl(
  filePath: string,
): Promise<{ dataUrl: string }> {
  const buf = readFileSync(filePath);

  // Use Bun.Image if available — resize + convert to JPEG
  if (typeof Bun !== "undefined" && typeof (Bun as any).Image !== "undefined") {
    try {
      const img = new (Bun as any).Image(buf);
      const { width } = await img.metadata();
      const targetWidth = Math.min(800, width || 800);
      const dataUrl = await img
        .resize(targetWidth, 800, { fit: "inside" })
        .jpeg({ quality: 60 })
        .dataurl();
      return { dataUrl };
    } catch {
      // Bun.Image failed — fall through to raw base64
    }
  }

  // Fallback: raw base64 (no resize)
  const b64 = buf.toString("base64");
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  return { dataUrl: `data:${mime};base64,${b64}` };
}

/**
 * Load an image from a URL, resize, return as JPEG data URL.
 */
export async function loadUrlAsDataUrl(
  url: string,
): Promise<{ dataUrl: string }> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  if (typeof Bun !== "undefined" && typeof (Bun as any).Image !== "undefined") {
    try {
      const img = new (Bun as any).Image(buf);
      const { width } = await img.metadata();
      const targetWidth = Math.min(800, width || 800);
      const dataUrl = await img
        .resize(targetWidth, 800, { fit: "inside" })
        .jpeg({ quality: 60 })
        .dataurl();
      return { dataUrl };
    } catch {
      // fall through
    }
  }

  const b64 = buf.toString("base64");
  return { dataUrl: `data:image/png;base64,${b64}` };
}

/**
 * Process a clipboard buffer (already resized by readClipboardImage)
 * into a data URL. Used by Ctrl+V handler.
 */
export async function bufferToDataUrl(buf: Buffer): Promise<{ dataUrl: string }> {
  if (typeof Bun !== "undefined" && typeof (Bun as any).Image !== "undefined") {
    try {
      const img = new (Bun as any).Image(buf);
      const { width } = await img.metadata();
      const targetWidth = Math.min(800, width || 800);
      const dataUrl = await img
        .resize(targetWidth, 800, { fit: "inside" })
        .jpeg({ quality: 60 })
        .dataurl();
      return { dataUrl };
    } catch {
      // fall through
    }
  }

  const b64 = buf.toString("base64");
  return { dataUrl: `data:image/png;base64,${b64}` };
}
