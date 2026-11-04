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
  /** Append a session log record to the active or an explicit session. */
  appendLog?(entry: SessionLogEntry, id?: string): void;
  getHistory?(id: string): SessionMessage[];
  /** Каталог сессии (для персиста web-метрик). Опционален — у лёгких стабов нет. */
  getSessionDirectory?(id: string): string;
}

/** Одно входящее сообщение, ждущее конца текущего хода (`POST /api/message` при busy). */
export interface QueuedMessage {
  /** Стабильный id в пуле: адресат отмены/принудительного старта. */
  id: string;
  text: string;
  images: string[];
  /**
   * Сессия-владелец сообщения. Заполняется из `POST /api/message {sessionId}`
   * (фолбэк — тогда-активная); дренаж переключается на неё перед стартом хода,
   * чтобы сообщение из вкладки B не уехало в сессию A (v2, per-session очередь).
   */
  sessionId: string | null;
  /** Когда принято (для сортировки/диагностики; порядок — порядок прихода). */
  ts: number;
}
