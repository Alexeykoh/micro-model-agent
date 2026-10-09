// Языковая идентификация файла. ЕДИНЫЙ источник правды для двух разных
// неймспейсов, которые раньше были продублированы (config.ts и client.ts) и
// расходились по `scss`:
//
// - `languageIdForPath` — LSP `languageId` из `textDocument/didOpen` (протокол).
// - `serverKeyForExt` — ключ записи в `lsp.servers` (конфиг, может отличаться).

const LANGUAGE_IDS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  py: "python",
  go: "go",
  rs: "rust",
  json: "json",
  html: "html",
  css: "css",
  scss: "scss",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
};

/** Расширение записи LSP-сервера → язык индексатора (ключ `lsp.servers`). */
const SERVER_KEYS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  html: "html",
  css: "css",
  scss: "css",
};

/** Расширение файла (без точки, в нижнем регистре) или пустая строка. */
export function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** LSP `languageId` для `textDocument/didOpen`; неизвестное — `plaintext`. */
export function languageIdForPath(filePath: string): string {
  return LANGUAGE_IDS[extensionOf(filePath)] ?? "plaintext";
}

/** Ключ конфигурации LSP-сервера по пути файла; неизвестное — null. */
export function serverKeyForPath(filePath: string): string | null {
  return SERVER_KEYS[extensionOf(filePath)] ?? null;
}
