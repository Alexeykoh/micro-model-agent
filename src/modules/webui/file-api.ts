// `GET /api/file?path=<p>` — read-only просмотр файлов для карточек чата («Open» — в новой вкладке,
// `&download=1` — тот же файл как attachment для кнопки скачивания).
//
// Безопасность (auth + same-origin — выше в server.ts):
// - путь резолвится от воркспейса агента и ОБЯЗАН остаться внутри (абсолютные
//   снаружи отвергаются);
// - симлинки (и Windows-джанкшены) резолвятся первыми, чтобы ссылка внутри
//   воркспейса не дотянулась до файла снаружи;
// - защищённые пути (`.git/`, `.env*`, ключи, credentials — см.
//   `matchProtectedPath`) отвергаются;
// - отдаются только обычные файлы до {@link MAX_FILE_VIEW_BYTES}, чтобы
//   мультигиговый лог не потёк в браузер.
//
// Ответы — как успехи, так и ошибки — `text/plain`: точка открывается прямо
// вкладкой браузера (JSON-тело рендерилось бы сырьём). Текст декодируется по
// BOM UTF-16 LE/BE или UTF-8; NUL-байты в других местах — бинарка, отказ.
// Одно ограничение: auth- и same-origin-отказы случаются выше в `server.ts`
// и остаются JSON — они достижимы лишь с missing/forged кукой, не из вьюера.
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { matchProtectedPath } from "../security/protected-paths";
import { t } from "../../i18n/index";
import type { WebUiState } from "./state";

/** Кап просматриваемого файла; большие отвергаются, а не режутся. */
export const MAX_FILE_VIEW_BYTES = 512 * 1024;

/** Вьюер открывается вкладкой браузера — ошибки читаются текстом, не JSON. */
function sendTextError(
  res: ServerResponse,
  status: number,
  key: string,
  vars?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(t(key, vars));
}

/** Декодирует текстовый буфер с учётом BOM UTF-16/UTF-8; NUL в других местах — бинарка. */
export function decodeText(buf: Buffer): { text: string; binary: boolean } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le"), binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // `swap16` отвергает нечётное число байт — свапаем только чётный префикс.
    const body = buf.subarray(2);
    const even = body.length - (body.length % 2);
    const swapped = Buffer.from(body.subarray(0, even));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), binary: false };
  }
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  if (body.includes(0)) return { text: "", binary: true };
  return { text: body.toString("utf8"), binary: false };
}

/** MIME для предпросмотра («Open»): безопасные растровые картинки, PDF и медиа
 * отдаются родным типом, чтобы вкладка их рисовала, а не показывала байты.
 * `.svg`/`.html` намеренно остаются `text/plain`: их исполнение в нашем
 * origin — XSS через модельно-записанный файл. */
export function mimeForView(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    case ".pdf":
      return "application/pdf";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
    case ".oga":
      return "audio/ogg";
    default:
      return "text/plain; charset=utf-8";
  }
}

/** Имя для `Content-Disposition`: без кавычек и переводов строк. */
export function safeFileName(absReal: string): string {
  const base = basename(absReal).replace(/["\r\n]/g, "_") || "file";
  return base;
}

/** True, когда `target` вне `base` (лексически). */
function escapes(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Обрабатывает `/api/file`. Возвращает `false` для чужих роутов, чтобы
 * вызывающий провалился к следующему хендлеру.
 */
export function handleFileApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  if (reqUrl.pathname !== "/api/file" || req.method !== "GET") return false;

  const base = s.workspace;
  if (!base) {
    sendTextError(res, 503, "web.file.error.workspace_unavailable");
    return true;
  }
  const raw = reqUrl.searchParams.get("path") ?? "";
  if (!raw) {
    sendTextError(res, 400, "web.file.error.missing_path");
    return true;
  }

  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  // Дешёвый лексический гард первым: очевидно внешний путь (напр.
  // `../../etc/passwd`) отвергаем до касания ФС, даже если цели нет.
  if (escapes(resolve(base), abs)) {
    sendTextError(res, 403, "web.file.error.outside_workspace");
    return true;
  }
  const download = reqUrl.searchParams.get("download") === "1";
  void serveFile(res, base, abs, download);
  return true;
}

/** Резолвит реальные пути, держит гард воркспейса, отдаёт файл на просмотр или скачивание. */
async function serveFile(
  res: ServerResponse,
  base: string,
  abs: string,
  download: boolean,
): Promise<void> {
  let baseReal: string;
  let absReal: string;
  try {
    // `realpath` идёт по симлинкам/джанкшенам; без него ссылка внутри воркспейса
    // указывала бы на любой файл диска в обход гарда ниже.
    baseReal = await realpath(resolve(base));
    absReal = await realpath(abs);
  } catch {
    sendTextError(res, 404, "web.file.error.not_found");
    return;
  }

  if (escapes(baseReal, absReal)) {
    sendTextError(res, 403, "web.file.error.outside_workspace");
    return;
  }
  if (matchProtectedPath(baseReal, absReal)) {
    sendTextError(res, 403, "web.file.error.protected_path");
    return;
  }

  try {
    const info = await stat(absReal);
    if (!info.isFile()) {
      sendTextError(res, 404, "web.file.error.not_found");
      return;
    }
    if (info.size > MAX_FILE_VIEW_BYTES) {
      sendTextError(res, 413, "web.file.error.too_large", {
        limit: String(MAX_FILE_VIEW_BYTES),
      });
      return;
    }
    const buf = await readFile(absReal);
    if (download) {
      serveDownload(res, absReal, buf);
      return;
    }
    servePreview(res, absReal, buf);
  } catch {
    // Каталог или нечитаемый файл — с точки зрения вьюера "не найдено".
    sendTextError(res, 404, "web.file.error.not_found");
  }
}

/** Скачивание универсально для любого формата: сырые байты + attachment, браузер сохраняет файл вместо рендера. */
function serveDownload(res: ServerResponse, absReal: string, buf: Buffer): void {
  const name = safeFileName(absReal);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

/** Предпросмотр во вкладке: картинки/PDF/медиа — родным типом, остальное — декодированным текстом. */
function servePreview(res: ServerResponse, absReal: string, buf: Buffer): void {
  const mime = mimeForView(absReal);
  if (mime !== "text/plain; charset=utf-8") {
    // Родной рендер картинки/PDF/медиа во вкладке; декодировать нечего.
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    res.end(buf);
    return;
  }
  const { text, binary } = decodeText(buf);
  if (binary) {
    sendTextError(res, 415, "web.file.error.binary_file");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}
