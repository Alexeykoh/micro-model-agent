/**
 * Реестр директив харнесса, переживающих компакцию (§1.5 аудита).
 *
 * Директивы харнесса («остановись и ответь честно», «сведи поиск к результату»,
 * «тул отключён») вставляются в контекст как `<system-summary>`. Компакция
 * вырезала **все** `<system-summary>` из удерживаемого хвоста, а one-shot флаги
 * при этом не сбрасывались: директива, вытесненная из контекста, больше никогда
 * не отправлялась — модель её просто не видела.
 *
 * Решение: директива ставится не «одноразово», а как **стоящая** — реестр
 * хранит `id → текст`, и компакция возвращает все стоящие директивы в контекст
 * одним сообщением. Условие директивы (стрик сбросился) снимает её из реестра.
 */
/** Идентификаторы директив харнесса. */
export type DirectiveId =
  | "duplicate"
  | "repeated_call"
  | "failed_batches"
  | "research"
  | "tool_disabled"
  | "cycle"
  | "artifact_churn"
  | "consecutive_failures";

/**
 * Минимальный контракт приёмника директивы. Опциональные методы — потому, что
 * тестовые заглушки контекст-менеджера их не содержат.
 */
export interface DirectiveSink {
  addMessage(message: { role: "user"; content: string }): void;
  setStandingDirective?: (id: string, text: string) => void;
  clearStandingDirective?: (id: string) => void;
}

/**
 * Ставит директиву: сообщение в контекст + регистрация как стоящей (переживёт
 * компакцию). Повторная выдача той же директивы обновляет текст, а не
 * добавляет второе сообщение.
 */
export function issueDirective(sink: DirectiveSink, id: DirectiveId, text: string): void {
  sink.setStandingDirective?.(id, text);
  sink.addMessage({ role: "user", content: `<system-summary>${text}</system-summary>` });
}

/** Снимает директиву: условие перестало выполняться (стрик сбросился). */
export function clearDirective(sink: DirectiveSink, id: DirectiveId): void {
  sink.clearStandingDirective?.(id);
}
