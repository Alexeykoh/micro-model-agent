// Симметричные преобразования путь файловой системы ↔ LSP URI.
//
// Спека требует URI как `file:///c%3A/...` style с percent-encoding
// небезопасных символов. Прежний `pathToUri` кодировал ничего, а `uriToPath`
// делал `decodeURIComponent` — путь с пробелом, `#`, `%` или не-ASCII
// давал битый или необратимый URI.

const WIN_DRIVE = /^\/?[a-zA-Z]:/;

/** Путь → `file://` URI с percent-encoding сегментов (Windows и POSIX). */
export function pathToUri(filePath: string): string {
  const forward = filePath.replace(/\\/g, "/");
  const prefix = WIN_DRIVE.test(forward) ? "file:///" : "file://";
  const body = prefix === "file:///" ? forward.replace(/^\//, "") : forward;
  // `encodeURIComponent` квотит "/" тоже; возвращаем разделители на место.
  return prefix + encodePathSegments(body);
}

/** `file://` URI → путь файловой системы (обратимо к `pathToUri`). */
export function uriToPath(uri: string): string {
  const withoutScheme = uri.replace(/^file:\/\//, "");
  const decoded = decodeUriPathSegments(withoutScheme);
  // `file:///C:/x` → `/C:/x`: снимаем ведущий слэш у windows-диска.
  return WIN_DRIVE.test(decoded) ? decoded.replace(/^\//, "") : decoded;
}

/**
 * Канонический ключ файла для внутренних карт (`documents`/`diagnostics`).
 *
 * Серверы на Windows присылают URI в своей записи: `file:///e%3A/projects/…`
 * (строчная буква диска, `%3A`), а клиент открывает документ как
 * `file:///E:/projects/…`. Сравнение строк не совпадало, `publishDiagnostics`
 * молча отбрасывался, и любой `checkFile` уходил в таймаут (C-08: «сервер не
 * ответил вовремя» на живом сервере). Ключ приводится к виду клиента: диск —
 * строчный, percent-encoding — канонический.
 */
export function canonicalUri(uri: string): string {
  if (!/^file:/i.test(uri)) return uri;
  const path = uriToPath(uri);
  const m = /^([a-zA-Z]):([\s\S]*)$/.exec(path);
  return pathToUri(m ? `${m[1].toLowerCase()}:${m[2]}` : path);
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeSegment(segment))
    .join("/");
}

/**
 * `encodeURIComponent` квотит и `:` — буква диска `C:` превращается в `C%3A`,
 * и URI перестаёт быть каноническим для серверов. `%3A` приходит только из
 * `:`, поэтому возврат двоеточия безопасен и обратим.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/g, ":");
}

function decodeUriPathSegments(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}
