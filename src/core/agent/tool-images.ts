/** Доставка изображений из тулов в контекст (pending-очередь к user-сообщению). */
import type { ContentPart, ImageUrlPart } from "../../llm/provider";

/**
 * Минимальный контракт менеджера контекста, нужный для доставки изображений
 * из тулов. Не тянем полный ContextManager ради тестируемости.
 */
export interface PendingImageSink {
  addPendingImage(part: ContentPart): void;
}

/**
 * Ставит изображения, произведённые тулом, в очередь pending-изображений
 * контекста. Они прикрепятся к следующему user-сообщению (обычно это
 * `<system-summary>` с итогами пакета тулов в конце batch'а) — так картинка
 * доходит до модели как валидный image-part, а не как base64-текст в
 * `role:"tool"` (который и не портируем, и усекается бюджетом).
 *
 * Намеренно не складывает изображения в промежуточные tool-сообщения:
 * вставка user-сообщения между результатами одного assistant(tool_calls)
 * нарушает порядок, требуемый Jinja-шаблонами (см. architecture.md).
 */
export function queueToolImages(
  sink: PendingImageSink | undefined,
  images: ImageUrlPart[] | undefined,
): void {
  if (!sink || !images || images.length === 0) return;
  for (const image of images) {
    sink.addPendingImage(image);
  }
}
