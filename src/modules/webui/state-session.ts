// Сессионные контракты веб-модуля: структурное подмножество `SessionManager`
// для REST и входящее сообщение очереди хода. Держим их вне `WebUiState`,
// чтобы god-state описывал только собственное состояние; `state.ts`
// реэкспортирует их, поэтому публичная поверхность не меняется.
import type { SessionLogEntry } from "../session/store";
import type { SessionMessage, SessionMeta } from "../session/types";

/**
 * Структурное подмножество `SessionManager` для веб-REST. Узкость даёт реальному
 * менеджеру удовлетворять его неявно, а тестам — стабить без кастов. Читалки
 * истории опциональны, чтобы лёгкие стабы только на list/activate/delete
 * оставались валидны; эндпоинт истории без них отвечает пустым транскриптом.
 * Сервер держит явный `WebUiState`, чтобы тесты гонялись герметично на свежем
 * объекте, а не на процесс-глобальном дефолте.
 */
export interface WebSessionManager {
  list(): SessionMeta[];
  get(id: string): SessionMeta | null;
  getActive(): string | null;
  setActive(id: string): void;
  /** Сброс активной сессии (закрытие последней вкладки). Опционален для стабов. */
  clearActive?(): void;
  delete(id: string): void;
  /**
   * Создаёт новую сессию (опционально именованную), возвращает мету. Опционален,
   * чтобы стабы только на list/activate/delete оставались валидны; эндпоинт
   * создания без него отвечает 503.
   */
  create?(name?: string): SessionMeta;
  loadSessionLog?(id: string, opts?: { since?: string }): SessionLogEntry[];
  /** Лог с причиной: `unreadable` не превращается в пустой Trace (INV-15). */
  loadSessionLogWithStatus?(
    id: string,
    opts?: { since?: string },
  ): import("../session/read-status").SessionRead<SessionLogEntry[]>;
  /** Мета с причиной: повреждённая сессия не отвечает `404 not_found`. */
  getWithStatus?(id: string): import("../session/read-status").SessionRead<SessionMeta>;
  /** Append a session log record to the active or an explicit session. */
  appendLog?(entry: SessionLogEntry, id?: string): void;
  getHistory?(id: string): SessionMessage[];
  /** Каталог сессии (для персиста web-метрик). Опционален — у лёгких стабов нет. */
  getSessionDirectory?(id: string): string;
}

/** Очередь входящего сообщения — контракт нейтрального runtime-слоя (RunPool). */
export type { QueuedMessage } from "../../runtime/run-pool/queued-message";
