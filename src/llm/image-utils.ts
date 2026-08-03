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

/**
 * Detect MIME type from file extension.
 */
export function detectMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "image/png";
}

/**
 * Load an image from a file path and return as base64 data URL.
 * Optionally resize if the raw data exceeds maxBytes.
 */
export function loadFileAsDataUrl(
  filePath: string,
  maxBytes?: number,
): { dataUrl: string; mime: string; resized: boolean } {
  const mime = detectMime(filePath);
  let buf: Buffer = readFileSync(filePath);
  let resized = false;

  if (maxBytes && buf.length > maxBytes) {
    buf = resizePngBuffer(buf, maxBytes);
    resized = true;
  }

  const b64 = buf.toString("base64");
  return { dataUrl: `data:${mime};base64,${b64}`, mime, resized };
}

/**
 * Load an image from a URL, return as base64 data URL.
 */
export async function loadUrlAsDataUrl(
  url: string,
): Promise<{ dataUrl: string; mime: string }> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image: ${resp.status} ${resp.statusText}`);
  }
  const contentType = resp.headers.get("content-type") ?? "image/png";
  const mime = contentType.split(";")[0].trim();
  const buf = Buffer.from(await resp.arrayBuffer());
  const b64 = buf.toString("base64");
  return { dataUrl: `data:${mime};base64,${b64}`, mime };
}

/**
 * Read image from system clipboard (platform-specific).
 * Returns null if clipboard has no image.
 */
export async function readClipboardImage(): Promise<string | null> {
  const { platform } = await import("os");

  if (platform() === "win32") {
    return readClipboardWindows();
  }
  if (platform() === "darwin") {
    return readClipboardMacos();
  }
  return readClipboardLinux();
}

async function readClipboardWindows(): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const tmpPath = `${process.env.TEMP || process.env.TMP || "/tmp"}\\mma-clip-${Date.now()}.png`;
    // Use single quotes in PowerShell to avoid backslash issues
    const psScript = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${tmpPath}'); Write-Output 'OK' } else { Write-Output 'EMPTY' }`;
    const out = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      timeout: 5000,
      encoding: "utf-8",
    });
    if (out.includes("OK")) {
      return tmpPath;
    }
    return null;
  } catch {
    return null;
  }
}

async function readClipboardMacos(): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const tmpPath = `/tmp/mma-clip-${Date.now()}.png`;
    execSync(`pngpaste "${tmpPath}"`, { timeout: 5000 });
    return tmpPath;
  } catch {
    return null;
  }
}

async function readClipboardLinux(): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const tmpPath = `/tmp/mma-clip-${Date.now()}.png`;
    execSync(
      `xclip -selection clipboard -t image/png -o > "${tmpPath}" 2>/dev/null`,
      { timeout: 5000 },
    );
    return tmpPath;
  } catch {
    return null;
  }
}

/**
 * Rough PNG resize by reducing dimensions.
 * This is a naive approach — for production, use sharp or jimp.
 * For now, we just warn if image is too large and return as-is.
 */
function resizePngBuffer(buf: Buffer, _maxBytes: number): Buffer {
  // Without a native image library, we can't reliably resize.
  // Return as-is and let the model handle it (or fail gracefully).
  // TODO: integrate sharp for proper resize
  return buf;
}
