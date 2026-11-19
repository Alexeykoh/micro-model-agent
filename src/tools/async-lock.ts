/**
 * FIFO-мьютекс для диспатча плагин-хуков. Плагины (execution stuck-detector,
 * lint-on-write, lsp) несут общее мутабельное состояние и не
 * конкурентно-безопасны. Параллельные форки (subagent-сиблинги)
 * делят один экземпляр — хуки сериализуются, а тело тула бежит конкурентно.
 */
export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Хвост всегда settle-resolved: упавший хук не должен ломать очередь.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
