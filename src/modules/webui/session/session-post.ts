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
import { inWorkspace } from "./project-scope";

/** Входы разбора хода: сессии, пул, workspace. */
export type PostState = SessionStore &
  RuntimeState &
  ConfigStore &
  HttpTransport &
  SseTransport &
  WorkspaceStore & {
    /** Визард не пройден: ход не стартует (409). */
    setupRequired?: boolean;
  };

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

/** Вход `Host.submit`: кто, что и в какую сессию (split W10). */
export interface PostInput {
  text: string;
  images: string[];
  sessionId?: string;
  clientTz?: ClientTz;
}

/**
 * Валидирует ход независимо от транспорта: формат уже разобран, здесь —
 * визард, пустая строка, существование сессии, граница проекта и раннер.
 *
 * HTTP-хендлер и `Host.submit` идут одним путём: политика хода живёт здесь,
 * а не в адаптере (INV-S2).
 */
export function validatePost(s: PostState, input: PostInput): ParsedPost {
  if (s.setupRequired) return { error: "setup_required", status: 409 };
  if (!input.text.trim()) return { error: "empty", status: 200 };
  const target = input.sessionId?.trim() || activeSessionOf(s);
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
  return {
    text: input.text,
    images: input.images,
    target,
    ...(input.clientTz ? { clientTz: input.clientTz } : {}),
  };
}
