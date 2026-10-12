/** Вентиль халлюцинаций: проверка финального ответа перед принятием. */
import { pc } from "../../ui/colors";
import { t } from "../../i18n/index";
import type { HallucinationDetector, HallucinationCheckResult } from "../../core/hallucination/detector";
import type { ArtifactState } from "../../core/hallucination/artifact-claim";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../core/context/manager";
import type { SessionLogger } from "../session-logger";
import { MAX_HALLUCINATION_RETRIES } from "./constants";
import type { LoopState } from "./loop-state";
import type { OnMeta } from "../types";
import { checkClaims, retractDraft } from "./hallucination-claims";

/** Вердикт вентиля: блокировать, предупредить, переспросить, выйти или принять. */
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

/** Зависимости вентиля: состояние, текст ответа, контекст, вывод. */
export interface HallucinationGateDeps {
  state: LoopState;
  textContent: string;
  input: string;
  exitOnComplete: boolean;
  hasFinalAudit: boolean;
  logger: Logger;
  contextManager: ContextManager;
  onMeta?: OnMeta;
  onChunk?: (chunk: string) => void;
  /** Verbosity чата — строка о неуверенности печатается только в verbose. */
  verbose: boolean;
  /**
   * Состояние файлов из ответа на диске (резолвит вызывающий, владелец baseDir).
   * Отсутствует/пусто — проверка заявлений пропускается.
   */
  artifacts?: ArtifactState[];
  /**
   * Логгер сессии для `claim_retry` (опционален — без него в session.jsonl
   * дырка: llm_usage отклонённого черновика без записи assistant).
   */
  slog?: SessionLogger;
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

  /**
   * Проверяет финальный текст ответа (детектор + заявления об успехе).
   * @param deps состояние, текст, контекст; @returns структурированный вердикт.
   */
  async evaluate(deps: HallucinationGateDeps): Promise<HallucinationVerdict> {
    const { state, textContent, logger } = deps;

    // Обновляем базу сравнения ДО validate: confidence-чек смотрит на
    // ПРЕДЫДУЩУЮ итерацию, иначе текст пересекался бы сам с собой.
    this.detector.getConfidenceCheck().setPreviousResponse(state.lastModelText);
    if (textContent) state.lastModelText = textContent;

    const result = await this.detector.validate(textContent);

    if (result.status === "block") {
      logger.diagnostic("warn", `Response blocked: ${result.reason}`);
      return { action: "block", reason: result.reason || "" };
    }

    if (result.status === "warn") {
      logger.diagnostic("warn", `Hallucination warning: ${result.reason}`);
      this.displayWarnLine(result.reason, deps);
      return { action: "warn" };
    }

    if (result.status === "retry") {
      // Черновик уже отстримлен — убираем до переответа (иначе дубль в ленте).
      retractDraft(deps, result.kind ?? "retry", result.reason ?? "");
      return this.applyRetry(deps, textContent, result);
    }

    // Проверка заявлений (ses_muih0ah5): сильное заявление о готовности
    // («done», «published», «готово»), когда свежие результаты тулов — с ошибками.
    // Одна ограниченная перепроверка — затем fail-open (принять как есть), не блок.
    const claimRetry = checkClaims(deps, textContent);
    if (claimRetry) return claimRetry;

    return { action: "accept" };
  }

  /**
   * Общий инжект повтора: фиксирует отклонённый ответ, дописывает причину
   * как `<system-summary>` и просит цикл о следующем ходе.
   */
  private applyRetry(
    deps: HallucinationGateDeps,
    textContent: string | undefined,
    result: HallucinationCheckResult,
  ): HallucinationVerdict {
    const { state, logger } = deps;
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
      logger.diagnostic(
        "warn",
        `Audit-triggered re-answer repetition — not counted as hallucination retry`,
      );
      this.displayWarnLine(result.reason, deps);
      return { action: "accept" };
    }
    if (state.hallucinationRetries >= MAX_HALLUCINATION_RETRIES) {
      logger.diagnostic(
        "warn",
        `Hallucination retries exhausted (${MAX_HALLUCINATION_RETRIES}), returning error`,
      );
      return { action: "block", reason: t("hall.max_retries_exhausted") };
    }
    state.hallucinationRetries++;
    logger.diagnostic(
      "warn",
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

  private displayWarnLine(reason: string | undefined, deps: HallucinationGateDeps): void {
    // Диагностика: в чате только пользовательские уведомления; модель всё равно
    // получает retry-контекст, вердикт остаётся в логах сессии/приложения.
    if (!deps.verbose) return;
    const warnLine = `${t("hall.uncertainty_prefix").trim()} ${reason ?? ""}`;
    if (deps.onMeta) {
      deps.onMeta(`\n${pc.yellow(warnLine)}\n`);
    } else if (deps.onChunk) {
      deps.onChunk(`\n${warnLine}\n`);
    }
  }
}