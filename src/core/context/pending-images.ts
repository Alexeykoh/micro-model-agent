/**
 * Очередь pending-картинок: кап и дедуп по содержимому.
 *
 * Вынесено из `ContextManager` (правило 6): очередь — самостоятельная единица
 * с одной ответственностью (кап 6 картинок, дубли не копятся, старые
 * вытесняются).
 */
import type { ContentPart } from "../../llm/provider";
import { MAX_QUEUED_TOOL_IMAGES, imageContentKey } from "../agent/tool-images";

/** Очередь картинок, ожидающих аттача к следующему user-сообщению. */
export class PendingImageQueue {
  private parts: ContentPart[] = [];

  /** Кладёт картинку: дубли по содержимому игнорируются, кап вытесняет старые. */
  add(part: ContentPart): void {
    const key = imageContentKey(part);
    if (key && this.parts.some((p) => imageContentKey(p) === key)) return;
    this.parts.push(part);
    while (this.parts.length > MAX_QUEUED_TOOL_IMAGES) this.parts.shift();
  }

  /** Есть ли картинки, ждущие аттача. */
  has(): boolean {
    return this.parts.length > 0;
  }

  /** Копия очереди (без очистки). */
  list(): ContentPart[] {
    return [...this.parts];
  }

  /** Забирает очередь и очищает её (аттач к user-сообщению). */
  takeAll(): ContentPart[] {
    const parts = this.parts;
    this.parts = [];
    return parts;
  }

  /** Очищает очередь (новый ход: картинки прошлого хода не должны утечь). */
  clear(): void {
    this.parts = [];
  }
}
