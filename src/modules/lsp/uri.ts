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
