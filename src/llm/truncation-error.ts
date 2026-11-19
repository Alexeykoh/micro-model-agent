/**
 * Ошибка «генерация оборвалась, не начав ответ».
 *
 * Два разных случая `finish_reason=length` требуют разных реакций, поэтому
 * различаются типом (`kind`) и текстом (спека
 * `2026-10-27-subagent-reliability-design` §B.1): обрезанный tool_call — «пиши
 * файл частями»; ноль текста и ноль tool_call — «бюджет съели рассуждения,
 * поднимай лимит». Один конструктор на стрим-путь и non-stream-фолбэк, чтобы
 * формулировки не разъезжались.
 */
import { LlmError } from "./llm-errors";
import { t } from "../i18n/index";

/** Что успел отдать поток до обрыва. */
export interface TruncationShape {
  /** Начался tool_call (аргументы обрезаны). */
  toolCallStarted: boolean;
  /** Пришёл хотя бы один символ ответа. */
  sawText: boolean;
  /** Пришли рассуждения. */
  sawReasoning: boolean;
}

/**
 * Собирает ошибку обрыва для вызова с лимитом `maxTokens`.
 * @returns `undefined`, если текст уже ушёл — это не обрыв «до ответа».
 */
export function truncationError(
  shape: TruncationShape,
  maxTokens: number,
): LlmError | undefined {
  if (shape.toolCallStarted) {
    return new LlmError(t("error.llm_truncated_toolcall", { tokens: maxTokens }), {
      terminal: true,
      recoverable: true,
      kind: "truncated_tool_call",
      limit: maxTokens,
    });
  }
  if (shape.sawText) return undefined;
  const key = shape.sawReasoning ? "error.llm_truncated_reasoning" : "error.llm_truncated";
  return new LlmError(t(key, { tokens: maxTokens }), {
    terminal: true,
    recoverable: true,
    kind: "truncated_no_content",
    limit: maxTokens,
  });
}
