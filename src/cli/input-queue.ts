/**
 * Последовательная очередь строк ввода REPL. `readline` эмитит `line` без ожидания
 * async-хендлера: пастнутый многострочный ввод обгонял сам себя (вывод команд
 * перемешивался), а `/exit` успевал закрыть REPL посреди хода агента.
 */
export class InputQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError?: (err: unknown) => void) {}

  /** Поставить задачу в хвост; упавшая задача не рвёт очередь. */
  push(task: () => void | Promise<void>): void {
    this.tail = this.tail.then(task).catch((err: unknown) => {
      this.onError?.(err);
    });
  }

  /** Дождаться опустошения очереди (шатдаун, тесты). */
  idle(): Promise<void> {
    return this.tail;
  }
}
