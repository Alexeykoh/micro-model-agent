/**
 * `GET /v1/host/sessions/:id/images/:name` (split W10).
 *
 * Сохранённые картинки тулов (`browser screenshot`, `attach_image`) живут в
 * `<sessionDir>/images/`; имя валидирует `readToolImage` (джейл против
 * traversal). Web-адаптер проксирует байты браузеру, поэтому демон отдаёт их
 * с тем же immutable-кэшем, что локальный веб.
 */
import type { ServerResponse } from "node:http";
import { readToolImage } from "../../session/image-store";
import type { AgentServiceState } from "../state";

/** Отдаёт байты картинки; `false` — маршрут не наш/сессия неизвестна. */
export function serveSessionImage(
  res: ServerResponse,
  s: AgentServiceState,
  sessionId: string,
  name: string,
): boolean {
  const manager = s.deps.sessionManager;
  const dir = manager?.get(sessionId) ? manager.getSessionDirectory?.(sessionId) : null;
  const img = dir ? readToolImage(dir, name) : null;
  if (!img) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return true;
  }
  // SVG — исполняемый формат: отдаём текстом вложением, а не рендерим.
  if (img.mime === "image/svg+xml") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    res.end(img.bytes);
    return true;
  }
  res.writeHead(200, {
    "Content-Type": img.mime,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  res.end(img.bytes);
  return true;
}
