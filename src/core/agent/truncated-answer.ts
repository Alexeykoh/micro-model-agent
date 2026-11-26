/**
 * Явная пометка обрезанного ответа. `finish_reason=length` означает, что
 * провайдер остановил генерацию на лимите completion-токенов: текст может
 * заканчиваться посреди фразы. Дочитывание потребовало бы второй LLM-вызов,
 * поэтому финал честно помечается — обрыв не выдаётся за полный ответ.
 */
import { t } from "../../i18n/index";

/** Добавить пометку к непустому ответу, оборванному по лимиту токенов. */
export function markTruncatedAnswer(
  text: string,
  finishReason: string | undefined,
  auditFailed: boolean,
): string;
export function markTruncatedAnswer(
  text: string | undefined,
  finishReason: string | undefined,
  auditFailed: boolean,
): string | undefined;
export function markTruncatedAnswer(
  text: string | undefined,
  finishReason: string | undefined,
  auditFailed: boolean,
): string | undefined {
  // Обычный `length` уже показывает предупреждение в ленте и не портит ответ:
  // метка нужна именно когда ответ принят после провала финального аудита.
  if (!text || finishReason !== "length" || !auditFailed) return text;
  const marker = t("error.answer_truncated");
  if (text.includes(marker)) return text;
  return `${text.trimEnd()}\n\n${marker}`;
}
