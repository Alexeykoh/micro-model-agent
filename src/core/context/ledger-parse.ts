// src/core/context/ledger-parse.ts
// Извлекает адреса-находки из результата тула (OO-6): `path:line` значений
// поиска, диапазон чтения (из аргументов, не из локализованного заголовка),
// URL веб-тулов. Без LLM и побочных эффектов.
//
// Имена тулов сверены с реестром (`src/tools/*.ts`): поиск — только `grep`
// (`grep-js` — внутренний движок, не тул); чтение — `read_file` (`file_info`
// исключён: возвращает JSON-метаданные, а не окно строк); URL-тулы —
// `web_fetch` / `web_browse` / `download_file` (все объявляют `urlArgs: ["url"]`).
// `browser` исключён намеренно: он запускается только по явной команде
// пользователя (AGENTS §8), его результат не является источником-адресом.
//
// Контракт вызова: `addressesFromToolResult` получает ТОЛЬКО успешные
// результаты тулов. Провалившиеся чтения/фетчи в леджер не попадают —
// это проверяется на вызывающей стороне (Task 4, узел записи леджера).
export interface AddressNote {
  address: string;
  note: string;
}

const SEARCH_TOOLS = new Set(["grep"]);
const READ_TOOLS = new Set(["read_file"]);
const URL_TOOLS = new Set(["web_fetch", "web_browse", "download_file"]);
const MAX_FINDINGS_PER_RESULT = 20;
const MAX_NOTE = 120;

/** Дефолты окна `read_file` (см. `DEFAULT_LIMIT` в `src/tools/read-file.ts`). */
const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 300;

/** Чистое извлечение адресов-находок из УСПЕШНОГО результата тула. */
export function addressesFromToolResult(
  name: string,
  args: Record<string, unknown>,
  content: string,
): AddressNote[] {
  if (SEARCH_TOOLS.has(name)) {
    const out: AddressNote[] = [];
    // `grep` уже отдаёт усечённый вывод (~15 строк), поэтому скан дешёвый.
    for (const line of content.split("\n")) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      out.push({ address: `${m[1]}:${m[2]}`, note: m[3].trim().slice(0, MAX_NOTE) });
      if (out.length >= MAX_FINDINGS_PER_RESULT) break;
    }
    return out;
  }
  if (READ_TOOLS.has(name)) {
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) return [];
    // Диапазон берём из аргументов (offset/limit — источник правды), а не из
    // заголовка вывода: тот локализован (`lines a-b` / `строки a-b`).
    const hasRange = typeof args.offset === "number" || typeof args.limit === "number";
    if (!hasRange) return [{ address: path, note: "" }];
    const offset = typeof args.offset === "number" ? Math.floor(args.offset) : DEFAULT_OFFSET;
    const limit = typeof args.limit === "number" ? Math.floor(args.limit) : DEFAULT_LIMIT;
    return [{ address: `${path}:${offset}`, note: `${offset}-${offset + limit - 1}` }];
  }
  if (URL_TOOLS.has(name)) {
    const url = typeof args.url === "string" ? args.url : undefined;
    return url ? [{ address: url, note: "" }] : [];
  }
  return [];
}
