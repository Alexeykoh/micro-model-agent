// Проекция списка сессий для REST `/api/sessions` и SSE `sessions`.
// Вынесено из `sessions-api.ts` (правило 6: ≤300 строк на файл).
import { inWorkspace } from "./project-scope";
import { broadcast, type SessionStore, type SseTransport, type WorkspaceStore } from "../state";

/** Проекция меты сессии для списка (`GET /api/sessions` и SSE `sessions`). */
export interface SessionMetaLite {
  id: string;
  name?: string;
  updatedAt?: string;
  model?: string;
  messageCount?: number;
  /** Каталог проекта сессии (чтобы UI не гадал, чья это история). */
  projectDir?: string;
}

/** Входы списка: сессии + workspace (фильтр по проекту). */
export type SessionListState = SessionStore & Pick<WorkspaceStore, "workspace">;

/**
 * Список сессий в форме, общей для REST и SSE — только текущего workspace.
 * `~/.mma/sessions` общий на все проекты, поэтому без фильтра в дропдауне
 * одного проекта висели чужие сессии (и продолжались ходом в чужом каталоге).
 */
export function sessionList(s: SessionListState): SessionMetaLite[] {
  if (!s.sessionManager) return [];
  return s.sessionManager
    .list()
    .filter((meta) => inWorkspace(meta, s.workspace))
    .map((meta) => ({
      id: meta.id,
      name: meta.name,
      updatedAt: meta.updatedAt,
      model: meta.model,
      messageCount: meta.messageCount,
      projectDir: meta.projectDir,
    }));
}

/** Рассылает список сессий событием `sessions` (замена 15с-поллу клиента). */
export function emitSessions(s: SessionListState & SseTransport): void {
  broadcast({ type: "sessions", ts: Date.now(), sessions: sessionList(s) }, s);
}
