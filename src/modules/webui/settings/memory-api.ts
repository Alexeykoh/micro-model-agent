// REST-хендлеры памяти (`/api/memory`): преференсы, записи, удаление.
//
// Вынесено из `settings-api.ts`: у памяти своя политика (кап записи), и файл
// настроек не должен расти из-за неё (правило 6 AGENTS).
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactContextSecrets } from "../../../core/api";
import { readBodyError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import type { ConfigStore, WorkspaceStore, HttpTransport, SseTransport } from "../state";

/** Кап одной записи памяти (символы): факт, а не дамп (аудит §6.5). */
export const MAX_MEMORY_ENTRY_CHARS = 20_000;

/** Append-only категории памяти (зеркало `memory-commands.ts` / `MemoryStore`). */
export const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

function isCategory(value: string): value is (typeof MEMORY_CATEGORIES)[number] {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

/** Запись памяти: номер и текст. */
interface MemoryEntry {
  n: number;
  text: string;
}

/** Режет append-only файл категории на записи с нумерацией от 1 (`- `-блоки). */
export function listEntries(markdown: string): MemoryEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) entries.push({ n: entries.length + 1, text: line });
  }
  return entries;
}

/** `GET /api/memory` — преференсы + записи по категориям (секреты вычищены). */
export function handleMemoryGet(
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
  if (!s.memory) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return;
  }
  const store = s.memory;
  const preferences: Record<string, string> = {};
  for (const [key, value] of Object.entries(store.getPreferences())) {
    preferences[key] = redactContextSecrets(String(value));
  }
  const categories = MEMORY_CATEGORIES.map((name) => ({
    name,
    entries: listEntries(store.read(name)).map((e) => ({
      n: e.n,
      text: redactContextSecrets(e.text),
    })),
  }));
  sendJson(res, 200, { preferences, categories });
}

/** `POST /api/memory {category, text}` — дописать запись. */
export function handleMemoryPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
  if (!s.memory) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return;
  }
  const store = s.memory;
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const category = typeof rec.category === "string" ? rec.category : "";
      const rawText = typeof rec.text === "string" ? rec.text.trim() : "";
      if (!isCategory(category) || rawText.length === 0) {
        sendJson(res, 400, { ok: false, error: "invalid-entry" });
        return;
      }
      const text =
        rawText.length > MAX_MEMORY_ENTRY_CHARS
          ? rawText.slice(0, MAX_MEMORY_ENTRY_CHARS)
          : rawText;
      store.append(category, text);
      sendJson(res, 200, {
        ok: true,
        ...(rawText.length > MAX_MEMORY_ENTRY_CHARS ? { truncated: true } : {}),
      });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `DELETE /api/memory/:category/:n` — забыть n-ю запись. */
export function handleMemoryDelete(
  res: ServerResponse,
  category: string,
  nRaw: string,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
  if (!s.memory) {
    sendJson(res, 503, { error: "memory_unavailable" });
    return;
  }
  if (!isCategory(category)) {
    sendJson(res, 400, { ok: false, error: "invalid-category" });
    return;
  }
  const n = parseInt(nRaw, 10);
  if (!(n > 0) || !s.memory.deleteEntry(category, n)) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  sendJson(res, 200, { ok: true });
}
