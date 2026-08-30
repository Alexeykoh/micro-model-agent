import { pc } from "../../ui/colors";
import { t } from "../../i18n/index";
import type { HallucinationDetector } from "../../modules/hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import { MAX_HALLUCINATION_RETRIES } from "./constants";
import type { LoopState } from "./loop-state";

export type HallucinationVerdict =
  /** Ответ заблокирован — цикл должен вернуть ошибку. */
  | { action: "block"; reason: string }
  /** Предупреждение показано — ответ проходит к принятию/аудиту. */
  | { action: "warn" }
  /** Нужен повтор: контекст пополнен, цикл делает continue. */
  | { action: "retry" }
  /** Exit-on-complete fast-exit: lastText/finalAnswerAccepted уже выставлены. */
  | { action: "exit" }
  /** Ответ принят (включая подавленный повтор после отклонения аудита). */
  | { action: "accept" };

export interface HallucinationGateDeps {
  state: LoopState;
  textContent: string;
  input: string;
  exitOnComplete: boolean;
  hasFinalAudit: boolean;
  logger: Logger;
  contextManager: ContextManager;
  onMeta?: (meta: string) => void;
  onChunk?: (chunk: string) => void;
}

/**
 * Вентиль проверки халлюцинаций финального текстового ответа.
 *
 * Объединяет весь граф вердиктов validate() (block/warn/retry) и их
 * под-пути: exit-on-complete fast-exit, подавление повтора после отказа
 * аудита (suppressRepetitionRetry), исчерпание повторов, добавление
 * retry-контекста в сообщения.
 *
 * Возвращает структурированный вердикт; решение о `break`/`continue`/`return`
 * принимает цикл. Вся мутация состояния живёт здесь — цикл остаётся тонким.
 */
export class HallucinationGate {
  constructor(private readonly detector: HallucinationDetector) {}

  async evaluate(deps: HallucinationGateDeps): Promise<HallucinationVerdict> {
    const { state, textContent, logger } = deps;

    // Обновляем базу сравнения ДО validate: confidence-чек смотрит на
    // ПРЕДЫДУЩУЮ итерацию, иначе текст пересекался бы сам с собой.
    this.detector.getConfidenceCheck().setPreviousResponse(state.lastModelText);
    if (textContent) state.lastModelText = textContent;

    const result = await this.detector.validate(textContent);

    if (result.status === "block") {
      logger.warn(`Response blocked: ${result.reason}`);
      return { action: "block", reason: result.reason || "" };
    }

    if (result.status === "warn") {
      logger.warn(`Hallucination warning: ${result.reason}`);
      this.displayWarnLine(result.reason, deps);
      return { action: "warn" };
    }

    if (result.status === "retry") {
      state.iterHallucinationRetry = true;
      // Exit-on-complete fast-exit НЕ должен обходить финальный аудит: при
      // активном плане модель может ответить "done" с невыполненными шагами
      // (регрессия сертификации: модель ответила, не запустив свой скрипт).
      // Короткое замыкание — только когда аудитить нечего.
      if (deps.exitOnComplete && textContent?.trim() && !deps.hasFinalAudit) {
        logger.debug("Exit-on-complete: stopping on first response");
        // Сохраняем ДО break — lastText всё ещё текст предыдущей (туловой)
        // итерации, и без этого итоговый ответ теряется (reported text: "").
        state.lastText = textContent;
        state.finalAnswerAccepted = true;
        return { action: "exit" };
      }
      if (state.suppressRepetitionRetry && result.kind === "repetition") {
        // Аудит отклонил предыдущий ответ и переспросил; его переформулировка
        // выполненной задачи естественно "повторяющаяся" — это ожидаемо, а не
        // деградация. Снижаем до предупреждения и пропускаем в acceptance path
        // (сам аудит ограничен MAX_AUDIT_RETRIES).
        state.suppressRepetitionRetry = false;
        logger.warn(`Audit-triggered re-answer repetition — not counted as hallucination retry`);
        this.displayWarnLine(result.reason, deps);
        return { action: "accept" };
      }
      if (state.hallucinationRetries >= MAX_HALLUCINATION_RETRIES) {
        logger.warn(
          `Hallucination retries exhausted (${MAX_HALLUCINATION_RETRIES}), returning error`,
        );
        return { action: "block", reason: t("hall.max_retries_exhausted") };
      }
      state.hallucinationRetries++;
      logger.warn(
        `Hallucination retry (${state.hallucinationRetries}/${MAX_HALLUCINATION_RETRIES}): ${result.reason}`,
      );
      if (textContent) {
        deps.contextManager.addMessage({ role: "assistant", content: textContent });
      }
      deps.contextManager.addMessage({
        role: "user",
        content: `<system-summary>[Retry context: ${result.reason}. Original task: "${deps.input}". You must either call a needed tool or provide a substantive response. Empty replies are not allowed.]</system-summary>`,
      });
      return { action: "retry" };
    }

    return { action: "accept" };
  }

  private displayWarnLine(reason: string | undefined, deps: HallucinationGateDeps): void {
    const warnLine = `${t("hall.uncertainty_prefix").trim()} ${reason ?? ""}`;
    if (deps.onMeta) {
      deps.onMeta(`\n${pc.yellow(warnLine)}\n`);
    } else if (deps.onChunk) {
      deps.onChunk(`\n${warnLine}\n`);
    }
  }
}