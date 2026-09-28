/** Типизированные ошибки LLM-транспорта (terminal/recoverable/status). */
/**
 * Типизированные ошибки LLM-транспорта.
 *
 * Раньше свойства `recoverableLlm` / `llmTerminal` / `llmStatus` навешивались
 * на обычные Error через `(err as any).xxx = ...` в 8 местах openai-compat.ts
 * и читались структурно в agent.ts и providers/fallback.ts — утка вместо
 * типа. Здесь — единый класс с явными флагами.
 *
 * Семантика флагов:
 * - `terminal`: поток уже не может продолжать (ответ доставлен, соединение
 *   сломано, запрос доретриен) — на уровне стрима ретраить НЕЛЬЗЯ;
 * - `recoverable`: причину стоит вернуть модели через агентный цикл
 *   (например, токен-лимит на середине tool_call) вместо смерти сессии;
 * - `llmStatus`: HTTP-статус для решения о failover между провайдерами.
 *
 * Ошибка может нести одновременно terminal + recoverable (обрезанный
 * tool_call: стрим не ретраим, но модель просим адаптироваться).
 */
export class LlmError extends Error {
  /** Поток не может продолжать — на уровне стрима не ретраить. */
  terminal: boolean;
  /** Причину вернуть модели через агентный цикл. */
  recoverable: boolean;
  /** HTTP-статус (для failover), если известен. */
  llmStatus: number | undefined;

  constructor(
    message: string,
    options: { terminal?: boolean; recoverable?: boolean; llmStatus?: number } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.terminal = options.terminal ?? false;
    this.recoverable = options.recoverable ?? false;
    this.llmStatus = options.llmStatus;
  }

  /**
   * Помечает ошибку терминальной (стрим не ретраится).
   * @returns this для чейнинга.
   */
  markTerminal(): this {
    this.terminal = true;
    return this;
  }

  /**
   * Помечает ошибку восстановимой (причину вернуть модели через цикл).
   * @returns this для чейнинга.
   */
  markRecoverable(): this {
    this.recoverable = true;
    return this;
  }
}