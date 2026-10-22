/** Доставка изображений из тулов в контекст (pending-очередь к user-сообщению). */
import type { ContentPart, ImageUrlPart } from "../../llm/provider";

/**
 * Кап pending-очереди изображений. Скриншоты копятся пачками (каждый тул-батч
 * может вернуть картинку), и без капа очередь съедала окно контекста: картинки
 * прикрепляются к следующему user-сообщению и уезжают в модель целиком.
 */
export const MAX_QUEUED_TOOL_IMAGES = 6;

/** Ключ содержимого картинки (data URL) — основа дедупа очереди. */
export function imageContentKey(part: ContentPart): string {
  return part.type === "image_url" ? (part.image_url?.url ?? "") : "";
}

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
