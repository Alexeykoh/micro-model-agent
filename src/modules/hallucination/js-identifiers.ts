/**
 * JS/TS-глобалы, чей member access (`process.env`, `console.log`, `Math.max`)
 * похож на путь к файлу для `\b[\w./\\-]+\.[a-z]+\b`-regex'ов, но является
 * кодом, а не файлом. Общий для фактической проверки галлюцинаций и аудитора
 * исполнения — оба перестают флаговать member access как "потерянные файлы".
 *
 * Здесь же общий фильтр "этот токен вообще файл?"
 * (`isFilePathLike` / `extractFileLikeTokens` / `stripUrls`), чтобы два
 * экстрактора не расходились (было: аудитор считал hostname URL
 * `whom-pointing-jewel-maine.trycloudflare.com` в шаге плана потерянным
 * файлом, а фактическая проверка корректно игнорировала).
 *
 * Голые токены `word.ext` гейтятся allow-list'ом реальных расширений
 * (`FILE_EXTENSIONS`), а не deny-list'ом TLD — домен в любом нынешнем или
 * будущем TLD (`Gismeteo.by`, `weather.com`, `example.xyz`) никогда не
 * спутается с файлом, и список TLD вести не нужно.
 */

const JS_GLOBALS = new Set([
  "process",
  "console",
  "math",
  "json",
  "global",
  "globalthis",
  "window",
  "document",
  "buffer",
  "module",
  "require",
  "exports",
  "url",
  "promise",
  "array",
  "object",
  "string",
  "number",
  "boolean",
  "symbol",
  "date",
  "regexp",
  "error",
  "map",
  "set",
  "weakmap",
  "weakset",
  "proxy",
  "reflect",
  "intl",
  "crypto",
  "performance",
  "fetch",
  "navigator",
  "location",
  "settimeout",
  "setinterval",
  "cleartimeout",
  "clearinterval",
  "queuemicrotask",
  "structuredclone",
  "textencoder",
  "textdecoder",
  "atomics",
  "sharedarraybuffer",
  "dataview",
  "arraybuffer",
  "bigint",
  "infinity",
  "nan",
  "undefined",
  "bun",
  "deno",
  "node",
]);

/**
 * True, если `candidate` начинается с известного JS/TS-глобала и точки
 * (`process.env`, `console.log`, частичные совпадения `process.env.NODE`
 * от `\b[\w./\\-]+\.[a-z]+`-regex'ов) — member access, не путь к файлу.
 */
export function isJsMemberAccess(candidate: string): boolean {
  const lower = candidate.toLowerCase();
  const m = lower.match(/^([\w-]+)\./);
  return m !== null && JS_GLOBALS.has(m[1]);
}

/**
 * Расширения, делающие голый токен `word.ext` похожим на путь к файлу.
 *
 * Allow-list осознанно: перечислять всё, что НЕ файл (TLD, бренды, …) —
 * хрупкая эвристика, которая никогда не полна. Вместо этого голый `word.ext`
 * считается файлом только при известном расширении — так `Gismeteo.by`,
 * `weather.com` и любой будущий TLD не флагуются, а настоящие
 * `config.json` / `helper.ts` — да.
 */
const FILE_EXTENSIONS = new Set([
  // исходники / код
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "pyc",
  "rb",
  "go",
  "rs",
  "java",
  "jar",
  "kt",
  "kts",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "php",
  "swift",
  "m",
  "mm",
  "lua",
  "pl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "cmd",
  "ps1",
  "vue",
  "svelte",
  "dart",
  // конфиги / данные / доки
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "drawio",
  "html",
  "htm",
  "md",
  "markdown",
  "rst",
  "txt",
  "log",
  "csv",
  "tsv",
  "lock",
  "sql",
  "sqlite",
  "db",
  "wasm",
  "map",
  "css",
  "scss",
  "sass",
  "less",
  // ассеты / бинарники
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tiff",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "zip",
  "gz",
  "tar",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "bin",
  "exe",
  "dll",
  "so",
  "o",
  "a",
  "dylib",
]);

/** Известные рантаймы/библиотеки на .js/.ts, которые НЕ файлы. */
const TECH_NAMES = new Set([
  "node.js",
  "react.js",
  "vue.js",
  "next.js",
  "angular.js",
  "express.js",
  "deno.js",
  "qwik.js",
  "svelte.js",
  "jquery.js",
]);

const FILE_TOKEN_RE = /\b(?:[a-zA-Z]:[\\/])?[\w./\\-]+\.[a-z]{1,6}\b/gi;

/**
 * True, если `candidate` — правдоподобный токен пути: у пути с разделителем
 * последний сегмент обязан нести непустой stem перед расширением (сегменты
 * только из расширения вроде `tsx/.ts` отбрасываются), а голый `word.ext` —
 * файл только при известном расширении (домены `Gismeteo.by` / `weather.com`
 * — никогда файлы). JS member access (`process.env`) и техно-имена
 * (`node.js`) — никогда файлы.
 */
export function isFilePathLike(s: string): boolean {
  const lower = s.toLowerCase();
  if (TECH_NAMES.has(lower)) return false;
  if (isJsMemberAccess(s)) return false;
  const ext = s.split(".").pop()?.toLowerCase() || "";
  if (!s.includes("/") && !s.includes("\\")) {
    if (!/^\w+\.[a-z]{1,6}$/i.test(s)) return false;
    return FILE_EXTENSIONS.has(ext);
  }
  // Токены с разделителем: требуем у ПОСЛЕДНЕГО сегмента настоящее имя
  // (непустой stem перед расширением). Иначе сегмент только из расширения
  // вроде "tsx/.ts" (из ".tsx/.ts" в описании шага) или дотфайл ("src/.env")
  // читается как файл, и deliverable-gate требует "создать tsx/.ts"
  // (было в ses_mstda6uo: шаг "Проверить что остались только .tsx/.ts файлы").
  const last = s.split(/[\\/]/).pop() ?? "";
  const lastDot = last.lastIndexOf(".");
  if (lastDot <= 0) return false;
  return true;
}

/**
 * Извлекает дедуплицированные файлоподобные токены из свободного текста.
 * Голые `word.ext` фильтруются через `isFilePathLike` (allow-list реальных
 * расширений — хосты/TLD вроде `whom-pointing-jewel-maine.trycloudflare.com`
 * или `Gismeteo.by` не выживают); URL вырезаются заранее, чтобы
 * `https://host/repo.git` не выжил как "файл".
 * Вызовы методов (`prev.map(`, `todos.map(` — переменная + метод, а `map`
 * есть в FILE_EXTENSIONS как sourcemap) — не файлы: путь к файлу никогда
 * не стоит вплотную перед `(`.
 */
export function extractFileLikeTokens(text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(FILE_TOKEN_RE.source, "gi");
  for (const m of text.matchAll(re)) {
    const token = m[0];
    const after = text[(m.index ?? 0) + token.length];
    if (after === "(") continue;
    if (isFilePathLike(token)) out.add(token);
  }
  return [...out];
}

/** Вырезает URL (scheme://… до пробела/кавычки), чтобы они не парсились как пути. */
export function stripUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, " ");
}
