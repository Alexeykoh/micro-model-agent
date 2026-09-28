import { pc } from "../../ui/colors";
import { t } from "../../i18n/index";
import type { HallucinationDetector, HallucinationCheckResult } from "../../modules/hallucination/detector";
import { checkSuccessClaim } from "../../modules/hallucination/success-claim";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import { MAX_CLAIM_CHECK_RETRIES, MAX_HALLUCINATION_RETRIES } from "./constants";
import type { LoopState } from "./loop-state";
import type { OnMeta } from "../types";

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
  onMeta?: OnMeta;
  onChunk?: (chunk: string) => void;
  /** Chat verbosity — the uncertainty warn line prints only in verbose mode. */
  verbose: boolean;
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
/**
 * Recent tool outputs for the success-claim check: last 10 `role:"tool"`
 * messages (capped text each — the checker caps again). Same
 * `getActiveHistory` source the critic gate uses.
 */
function lastToolEvidence(deps: HallucinationGateDeps): Array<{ name?: string; ok?: boolean; text: string }> {
  let history: Array<{ role: string; name?: string; content?: unknown; success?: boolean }>;
  try {
    history = deps.contextManager.getActiveHistory() ?? [];
  } catch {
    return [];
  }
  return history
    .filter((m) => m.role === "tool")
    .slice(-10)
    .map((m) => ({
      name: m.name,
      ok: m.success,
      text:
        typeof m.content === "string" ? m.content : JSON.stringify(m.content) ?? "",
    }))
    .filter((m) => m.text.trim().length > 0);
}

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
      logger.diagnostic("warn", `Response blocked: ${result.reason}`);
      return { action: "block", reason: result.reason || "" };
    }

    if (result.status === "warn") {
      logger.diagnostic("warn", `Hallucination warning: ${result.reason}`);
      this.displayWarnLine(result.reason, deps);
      return { action: "warn" };
    }

    if (result.status === "retry") {
      return this.applyRetry(deps, textContent, result);
    }

    // Success-claim check (ses_muih0ah5): a strong completion claim ("done",
    // "published", "готово") while recent tool results show errors. One
    // bounded re-check — then fail open (accept as-is), never a block.
    const claimRetry = this.checkSuccessClaim(deps, textContent);
    if (claimRetry) return claimRetry;

    return { action: "accept" };
  }

  /**
   * Shared retry injection: record the rejected answer, append the reason as
   * `<system-summary>`, and ask the loop for another turn.
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

  /**
   * Deterministic claim-vs-evidence check (no LLM). Returns a retry verdict
   * on the first contradiction, null afterwards (fail open) or when clean.
   */
  private checkSuccessClaim(
    deps: HallucinationGateDeps,
    textContent: string | undefined,
  ): HallucinationVerdict | null {
    const { state, logger } = deps;
    const contradiction = checkSuccessClaim(textContent ?? "", lastToolEvidence(deps));
    if (!contradiction || state.claimCheckRetries >= MAX_CLAIM_CHECK_RETRIES) {
      return null;
    }
    state.claimCheckRetries++;
    state.iterHallucinationRetry = true;
    // The re-answer restates a completed task and is naturally repetitive —
    // do not burn the hallucination budget on its shape (same rationale as
    // the audit-triggered downgrade above).
    state.suppressRepetitionRetry = true;
    const reason = t("hall.claim_contradiction", {
      tool: contradiction.tool,
      snippet: contradiction.snippet,
    });
    logger.diagnostic(
      "warn",
      `Success-claim contradiction: ${contradiction.tool}: ${contradiction.snippet}`,
    );
    if (textContent) {
      deps.contextManager.addMessage({ role: "assistant", content: textContent });
    }
    deps.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${reason} Original task: "${deps.input}".</system-summary>`,
    });
    return { action: "retry" };
  }

  private displayWarnLine(reason: string | undefined, deps: HallucinationGateDeps): void {
    // Diagnostic: the chat keeps only user-facing notices; the model still gets
    // the retry context and the verdict stays in the session/app logs.
    if (!deps.verbose) return;
    const warnLine = `${t("hall.uncertainty_prefix").trim()} ${reason ?? ""}`;
    if (deps.onMeta) {
      deps.onMeta(`\n${pc.yellow(warnLine)}\n`);
    } else if (deps.onChunk) {
      deps.onChunk(`\n${warnLine}\n`);
    }
  }
}