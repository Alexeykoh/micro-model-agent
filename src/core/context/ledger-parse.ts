// src/core/context/ledger-parse.ts
// Извлекает адреса-находки из результата тула (OO-6): `path:line` значений
// поиска, диапазон чтения, URL веб-тулов. Без LLM и побочных эффектов.
//
// Имена тулов сверены с реестром (`src/tools/*.ts`): поиск — только `grep`
// (`grep-js` — внутренний движок, не тул); чтение — `read_file` / `file_info`;
// веб с `url`-аргументом — `web_fetch` / `web_browse` (`web_search` принимает
// `query`, а не url, поэтому не входит).
export interface AddressNote {
  address: string;
  note: string;
}

const SEARCH_TOOLS = new Set(["grep"]);
const READ_TOOLS = new Set(["read_file", "file_info"]);
const URL_TOOLS = new Set(["web_fetch", "web_browse"]);
const MAX_FINDINGS_PER_RESULT = 20;
const MAX_NOTE = 120;

/** Чистое извлечение адресов-находок из результата тула. */
export function addressesFromToolResult(
  name: string,
  args: Record<string, unknown>,
  content: string,
): AddressNote[] {
  if (SEARCH_TOOLS.has(name)) {
    const out: AddressNote[] = [];
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
    const head = content.split("\n").find((l) => l.trim()) ?? "";
    const range = head.match(/lines (\d+)-(\d+)/);
    return [
      {
        address: range ? `${path}:${range[1]}` : path,
        note: range ? `lines ${range[1]}-${range[2]}` : "read",
      },
    ];
  }
  if (URL_TOOLS.has(name)) {
    const url = typeof args.url === "string" ? args.url : undefined;
    return url ? [{ address: url, note: "fetched" }] : [];
  }
  return [];
}
