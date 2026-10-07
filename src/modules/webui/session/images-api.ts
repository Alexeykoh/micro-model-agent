// `GET /api/sessions/:id/images/:name` — отдаёт сохранённые картинки тулов
// (browser screenshot / attach_image) из `<sessionDir>/images/`.
//
// Файлы пишет ядро (`SessionLogger.persistToolImages` → `image-store`) с
// ротацией по `images.maxCount/maxBytes`, поэтому 404 — штатный исход
// (ротация/чистка); клиент рисует приглушённую пометку вместо битой картинки.
//
// Имя файла валидируется (`isSafeImageName`) — джейл против traversal.
// Auth и same-origin — выше в `server.ts`.
import type { ServerResponse } from "node:http";
import { readToolImage } from "../../session/image-store";
import type { SessionStore } from "../state";

/** 404 JSON (нет сессии / нет файла / небезопасное имя). */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not_found" }));
}

/**
 * `GET /api/sessions/:id/images/:name` — байты картинки с immutable-кэшем.
 * Имена только из нашего алфавита; битые пути упираются в `readToolImage`.
 */
export function handleSessionImage(
  res: ServerResponse,
  id: string,
  name: string,
  s: SessionStore,
): void {
  const mgr = s.sessionManager;
  const dir = mgr?.get(id) ? mgr.getSessionDirectory?.(id) : null;
  if (!dir) {
    notFound(res);
    return;
  }
  const img = readToolImage(dir, name);
  if (!img) {
    notFound(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": img.mime,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  res.end(img.bytes);
}
