// FIFO-очередь входящих сообщений слота сессии.
//
// Вынесено из `session-pool.ts`: очередь — самостоятельный шов со своей
// нумерацией и капом, и пул не должен расти из-за неё (правило 6 AGENTS).
import type { QueuedMessage } from "../state";

/** Очередь сообщений слота: FIFO, монотонные id, кап по длине. */
export class SlotQueue {
  private items: QueuedMessage[] = [];
  private nextId = 1;

  /** Длина очереди. */
  get length(): number {
    return this.items.length;
  }

  /** Все сообщения (для проекций и снимков). */
  all(): QueuedMessage[] {
    return this.items;
  }

  /** Кладёт сообщение в очередь; null — очередь полна. */
  enqueue(
    text: string,
    images: string[],
    sessionId: string | null,
    max: number,
  ): QueuedMessage | null {
    if (this.items.length >= max) return null;
    const message: QueuedMessage = {
      id: `q${this.nextId++}`,
      text,
      images,
      sessionId,
      ts: Date.now(),
    };
    this.items.push(message);
    return message;
  }

  /** Упорядоченные id очереди. */
  ids(): string[] {
    return this.items.map((m) => m.id);
  }

  /** Убирает сообщение по id; undefined — такого уже нет. */
  remove(messageId: string): QueuedMessage | undefined {
    const i = this.items.findIndex((m) => m.id === messageId);
    if (i === -1) return undefined;
    return this.items.splice(i, 1)[0];
  }

  /** Переносит сообщение в голову очереди, сохраняя порядок остальных. */
  promote(messageId: string): QueuedMessage | undefined {
    const i = this.items.findIndex((m) => m.id === messageId);
    if (i === -1) return undefined;
    const [message] = this.items.splice(i, 1);
    this.items.unshift(message);
    return message;
  }

  /** Забирает голову очереди (undefined — пусто). */
  shift(): QueuedMessage | undefined {
    return this.items.shift();
  }

  /** Очистка очереди. */
  clear(): void {
    this.items = [];
  }
}
