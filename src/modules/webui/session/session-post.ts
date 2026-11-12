// Разбор `POST /api/message`: текст/картинки/сессия-владелец и граница проекта.
// Вынесено из `turns.ts` (правило 6: ≤300 строк на файл).
import type { ClientTz } from "../../../core/prompt-facts";
import type {
  ConfigStore,
  HttpTransport,
  RuntimeState,
  SessionStore,
  SseTransport,
  WorkspaceStore,
} from "../state";
import { parseMessageBody } from "../util";
import { inWorkspace } from "./project-scope";

/** Входы разбора хода: сессии, пул, workspace. */
export type PostState = SessionStore &
  RuntimeState &
  ConfigStore &
  HttpTransport &
  SseTransport &
  WorkspaceStore;

/**
 * Достаёт `sessionId` из сырого JSON-тела (фронт шлёт вкладку-владельца).
 * Пусто/мусор → null (фолбэк — тогда-активная). Битый JSON отдаст
 * `parseMessageBody`, здесь не шумим. Прямой `JSON.parse`, а не `parseJsonBody`:
 * `body.ts` импортирует `readBody` из `util.ts`, обратный импорт дал бы цикл.
 */
export function extractSessionId(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const id = (parsed as Record<string, unknown>).sessionId;
      if (typeof id === "string" && id.trim()) return id.trim();
    }
  } catch {
    /* invalid JSON — разберёт parseMessageBody */
  }
  return null;
}

/** Тогда-активная сессия (фолбэк, когда фронт sessionId не прислал). */
export function activeSessionOf(s: PostState): string | null {
  try {
    const manager = s.sessionManager as unknown as
      { getActive?: () => string | null; getActiveMeta?: () => { id: string } | null } | undefined;
    return manager?.getActive?.() ?? manager?.getActiveMeta?.()?.id ?? s.activeSessionId ?? null;
  } catch {
    return s.activeSessionId ?? null;
  }
}

/** Разобранное тело `POST /api/message`: текст, картинки, сессия-владелец. */
export type ParsedPost =
  | { text: string; images: string[]; target: string; clientTz?: ClientTz }
  | { error: string; status: number };

/**
 * Валидирует тело сообщения: формат, существование сессии, проект, раннер.
 * Чистая (без записи состояния) — решение о резерве/очереди принимает диспетчер.
 */
export function parsePost(s: PostState, raw: string): ParsedPost {
  const body = parseMessageBody(raw);
  if ("error" in body) return { error: body.error, status: 400 };
  const target = extractSessionId(raw) ?? activeSessionOf(s);
  if (!target) return { error: "no_session", status: 503 };
  if (s.sessionManager) {
    const meta = s.sessionManager.get(target);
    if (!meta) return { error: "not_found", status: 404 };
    // Ход чужой сессии шёл бы контекстом ЕЁ проекта (мета `projectDir`), а
    // пользователь видит workspace этого: агент молча правил бы файлы другого
    // репозитория. Проект сессии — часть границы, а не подсказка.
    if (!inWorkspace(meta, s.workspace)) {
      return { error: "foreign_project", status: 403 };
    }
  }
  // Web всегда через раннер: без фабрики исполнителя нет.
  if (!s.pool.hasFactory()) return { error: "no_runner", status: 503 };
  return { text: body.text, images: body.images, target, clientTz: body.clientTz };
}
