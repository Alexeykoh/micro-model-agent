/** Хранилище изображений тулов на сессии: запись, чтение, ротация. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Ссылка на сохранённое изображение (попадает в session.jsonl и по сети). */
export interface ToolImageRef {
  file: string;
  mime: string;
  bytes: number;
}

/** Полноразмерный ассет тула для персиста (в дополнение к model data URL). */
export interface ToolImageAsset {
  bytes: Uint8Array;
  mime: string;
}

const IMG_DIR = "images";
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Безопасное имя файла (без разделителей и `..`) — защита от traversal. */
export function isSafeImageName(name: string): boolean {
  return NAME_RE.test(name) && name !== "." && name !== ".." && !name.includes("..");
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Декодирует `data:image/...;base64,...` в байты + mime. */
export function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("not a base64 data URL");
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

/** Каталог изображений сессии. */
function imagesDir(sessionDir: string): string {
  return join(sessionDir, IMG_DIR);
}

/** Сохраняет ассет и применяет ротацию; возвращает ref. */
export function saveToolImage(
  sessionDir: string,
  asset: ToolImageAsset,
  limits: { maxCount: number; maxBytes: number },
): ToolImageRef {
  const dir = imagesDir(sessionDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = EXT[asset.mime] ?? "bin";
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = Buffer.from(asset.bytes);
  writeFileSync(join(dir, file), bytes, { mode: 0o600 });
  const ref: ToolImageRef = { file, mime: asset.mime, bytes: bytes.length };
  pruneToolImages(sessionDir, limits);
  return ref;
}

/** Удаляет старейшие (по mtime) файлы, пока count/bytes выше лимитов. */
export function pruneToolImages(
  sessionDir: string,
  limits: { maxCount: number; maxBytes: number },
): void {
  const dir = imagesDir(sessionDir);
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir)
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => a.mtime - b.mtime);
  let count = entries.length;
  let total = entries.reduce((s, e) => s + e.size, 0);
  for (const e of entries) {
    if (count <= limits.maxCount && total <= limits.maxBytes) break;
    rmSync(join(dir, e.name), { force: true });
    count -= 1;
    total -= e.size;
  }
}

/** Читает файл по имени; небезопасное/отсутствующее — null. */
export function readToolImage(
  sessionDir: string,
  name: string,
): { bytes: Buffer; mime: string } | null {
  if (!isSafeImageName(name)) return null;
  const p = join(imagesDir(sessionDir), name);
  if (!existsSync(p)) return null;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  return { bytes: readFileSync(p), mime };
}
