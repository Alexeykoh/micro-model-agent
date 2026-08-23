export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

export function safeJson(args: Record<string, unknown>): string {
  try {
    return clip(JSON.stringify(args, null, 2), 200_000);
  } catch {
    return clip(String(args), 200_000);
  }
}

/** One-line summary of the most salient args for quick scanning. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (parts.length >= 4) {
      parts.push("…");
      break;
    }
    if (v === null || v === undefined) parts.push(`${k}: null`);
    else if (typeof v === "string") {
      parts.push(
        v.length <= 40
          ? `${k}: ${JSON.stringify(v)}`
          : `${k}: ${JSON.stringify(v.slice(0, 40))}…(${v.length})`,
      );
    } else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: [${v.length}]`);
    else parts.push(`${k}: {…}`);
  }
  return parts.join(" · ");
}

// Safety net: mask credential-shaped values. Content stays otherwise intact.
const SECRET_FIELD =
  /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret|authorization)["']?\s*[:=]\s*)(["']?)([^"',}\s]{8,})/gi;

export function scrub(text: string): string {
  let out = text;
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***");
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer ***");
  out = out.replace(SECRET_FIELD, "$1$2***");
  return out;
}

const IMAGE_DATAURL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

/** True when the string looks like an image data URL the browser may send. */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8_000_000 && IMAGE_DATAURL.test(value);
}

export interface ValidationResult {
  ok: boolean;
  status?: number;
  error?: string;
  text?: string;
  images?: string[];
}

/**
 * Validate a POST /api/message body. Caps: text ≤ MAX_MESSAGE_CHARS,
 * images ≤ MAX_IMAGES each matching a strict data-URL pattern.
 */
export function validateMessageBody(
  raw: unknown,
  maxChars: number,
  maxImages: number,
): ValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, status: 400, error: "text is required" };
  }
  if (text.length > maxChars) {
    return { ok: false, status: 413, error: `text exceeds ${maxChars} chars` };
  }
  const images = body.images ?? [];
  if (!Array.isArray(images)) {
    return { ok: false, status: 400, error: "images must be an array" };
  }
  if (images.length > maxImages) {
    return { ok: false, status: 400, error: `at most ${maxImages} images per message` };
  }
  for (const img of images) {
    if (!isImageDataUrl(img)) {
      return { ok: false, status: 400, error: "each image must be an image/* data URL under 6MB" };
    }
  }
  return { ok: true, text, images: images as string[] };
}
