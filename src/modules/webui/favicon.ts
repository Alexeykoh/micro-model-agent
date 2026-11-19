// Favicon for `mma web`: the project's own icon when it has one, the MMART
// mascot otherwise. Read-only, bounded, and rooted at the workspace — the
// endpoint never accepts a path from the client.
import type { ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

/** Узкий срез состояния: только корень workspace. */
export interface FaviconSource {
  workspace?: string;
}

/** Разрешённые типы иконок; всё остальное не отдаём. */
const MIME: Record<string, string> = {
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Имена, под которыми проекты держат иконку. */
const NAMES = ["favicon.ico", "favicon.png", "favicon.svg", "favicon.webp", "favicon.gif"];

/** Каталоги, где иконка встречается в типовых раскладках. */
const DIRS = [
  "",
  "public",
  "static",
  "assets",
  "img",
  "images",
  "src",
  "app",
  "src/app",
  // Статические сайты/доки проекта (в этом репозитории — `gh-pages/`).
  "docs",
  "gh-pages",
];

/** Кап: иконка не должна тянуть мегабайты в память на каждый запрос. */
const MAX_FAVICON_BYTES = 512 * 1024;

/** Найденная иконка: тело и её MIME-тип. */
export interface FaviconAsset {
  body: Buffer;
  type: string;
}

/**
 * Ищет иконку проекта в workspace по фиксированному списку имён и каталогов.
 * Путь клиента не участвует — обойти allowlist нельзя.
 */
export function findProjectFavicon(workspace: string | undefined): FaviconAsset | null {
  if (!workspace) return null;
  const root = resolve(workspace);
  for (const dir of DIRS) {
    for (const name of NAMES) {
      const path = join(root, dir, name);
      try {
        if (!existsSync(path)) continue;
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FAVICON_BYTES) continue;
        const type = MIME[extname(name).toLowerCase()];
        if (!type) continue;
        return { body: readFileSync(path), type };
      } catch {
        /* нет доступа/битый файл — ищем дальше */
      }
    }
  }
  return null;
}

/**
 * Маскот MMART как SVG: тот же силуэт (сквиркл + два глаза), что в чате.
 * Отдельный файл не нужен — иконка целиком помещается в ответ.
 */
export const MASCOT_FAVICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
  '<rect x="6" y="6" width="52" height="52" rx="17" fill="#c4a8ec"/>',
  '<ellipse cx="24" cy="29" rx="4.6" ry="6.4" fill="#1f1f1f"/>',
  '<ellipse cx="40" cy="29" rx="4.6" ry="6.4" fill="#1f1f1f"/>',
  "</svg>",
].join("");

/** `GET /api/favicon` — иконка проекта или маскот. */
export function handleFaviconGet(res: ServerResponse, s: FaviconSource): void {
  const found = findProjectFavicon(s.workspace);
  // Buffer, not string: the egress wrapper edits strings (and may change their
  // length after Content-Length was computed). Bytes pass through untouched.
  const body = found ? found.body : Buffer.from(MASCOT_FAVICON);
  const type = found ? found.type : "image/svg+xml; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    // Иконка проекта может измениться без рестарта — браузер должен спросить.
    "Cache-Control": "no-cache",
  });
  res.end(body);
}
