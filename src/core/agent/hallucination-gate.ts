/** Вентиль халлюцинаций: проверка финального ответа перед принятием. */
import { pc } from "../../ui/colors";
import { t } from "../../i18n/index";
import type { HallucinationDetector, HallucinationCheckResult } from "../../core/hallucination/detector";
import { checkSuccessClaim } from "../../core/hallucination/success-claim";
import type { ClaimContradiction } from "../../core/hallucination/success-claim";
import {
  checkArtifactClaims,
  checkUnverifiedOutput,
  type ArtifactState,
} from "../../core/hallucination/artifact-claim";
import { checkWebClaims } from "../../core/hallucination/web-claims";
import { checkClaimedFileCreation } from "../../core/hallucination/file-creation-claim";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../core/context/manager";
import type { SessionLogger } from "../session-logger";
import { MAX_CLAIM_CHECK_RETRIES, MAX_HALLUCINATION_RETRIES } from "./constants";
import type { LoopState } from "./loop-state";
import type { OnMeta } from "../types";

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
/**
 * Свежие выводы тулов для проверки заявлений: последние 10 сообщений
 * role:"tool" (текст урезан; чекер режет повторно). Тот же источник
 * getActiveHistory, что у вентиля критика.
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
      this.retractDraft(deps, result.kind ?? "retry", result.reason ?? "");
      return this.applyRetry(deps, textContent, result);
    }

    // Проверка заявлений (ses_muih0ah5): сильное заявление о готовности
    // («done», «published», «готово»), когда свежие результаты тулов — с ошибками.
    // Одна ограниченная перепроверка — затем fail-open (принять как есть), не блок.
    const claimRetry = this.checkSuccessClaim(deps, textContent);
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

  /**
   * Детерминированные проверки заявлений против улик (без LLM): исходная
   * проверка success-claim плюс заземление артефактов (файл отсутствует/
   * не парсится) и провенанс вывода (вывод подан как исполненный без
   * исполняющего тула). У каждого класса свой ограниченный бюджет перепроверок
   * (fail-open): съеденный бюджет одной проверки не должен экранировать другую
   * ложь в том же ответе (наблюдалось: retry success-claim съел единый бюджет,
   * и «output written to fizzbuzz_output.txt» прошёл при отсутствующем файле).
   */
  /**
   * Детерминированные проверки заявлений финального ответа (без LLM): каждая —
   * свой класс с отдельным bounded-бюджетом. Возвращает первый вердикт retry
   * или null. Разнесено на таблицу классов, чтобы не держать всё в одном
   * методе (сложность/читаемость).
   */
  private checkSuccessClaim(
    deps: HallucinationGateDeps,
    textContent: string | undefined,
  ): HallucinationVerdict | null {
    const { state } = deps;
    const text = textContent ?? "";
    const evidence = lastToolEvidence(deps);
    const classes: Array<{
      remaining: number;
      bump: () => void;
      detect: () => (ClaimContradiction & { path?: string }) | null;
      reason: (c: ClaimContradiction & { path?: string }) => string;
      log: string;
      kind: string;
    }> = [
      {
        remaining: MAX_CLAIM_CHECK_RETRIES - state.claimCheckRetries,
        bump: () => state.claimCheckRetries++,
        detect: () => checkSuccessClaim(text, evidence),
        reason: (c) => t("hall.claim_contradiction", { tool: c.tool, snippet: c.snippet }),
        log: "Success-claim contradiction",
        kind: "success",
      },
      {
        remaining: deps.artifacts?.length
          ? MAX_CLAIM_CHECK_RETRIES - state.artifactClaimRetries
          : 0,
        bump: () => state.artifactClaimRetries++,
        detect: () => checkArtifactClaims(text, deps.artifacts ?? []),
        reason: (c) => t("hall.claim_artifact", { path: c.path ?? "", detail: c.snippet }),
        log: "Artifact-claim contradiction",
        kind: "artifact",
      },
      {
        remaining: MAX_CLAIM_CHECK_RETRIES - state.outputClaimRetries,
        bump: () => state.outputClaimRetries++,
        detect: () => checkUnverifiedOutput(text, evidence),
        reason: (c) => t("hall.claim_output_unverified", { detail: c.snippet }),
        log: "Unverified output",
        kind: "output",
      },
      {
        remaining: MAX_CLAIM_CHECK_RETRIES - state.webClaimRetries,
        bump: () => state.webClaimRetries++,
        detect: () => checkWebClaims(text, evidence),
        reason: (c) => t("hall.claim_web_unverified", { detail: c.snippet }),
        log: "Unverified web figures",
        kind: "web",
      },
      {
        remaining: MAX_CLAIM_CHECK_RETRIES - state.fileCreationRetries,
        bump: () => state.fileCreationRetries++,
        detect: () => checkClaimedFileCreation(text, evidence, deps.input),
        reason: (c) => t("hall.claim_file_not_created", { detail: c.snippet }),
        log: "Claimed file creation without a write",
        kind: "file",
      },
    ];
    for (const cls of classes) {
      if (cls.remaining <= 0) continue;
      const contradiction = cls.detect();
      if (!contradiction) continue;
      cls.bump();
      return this.retryClaim(
        deps,
        textContent,
        cls.reason(contradiction),
        `${cls.log}: ${contradiction.snippet}`,
        cls.kind,
      );
    }
    return null;
  }

  /**
   * Отклонённый черновик уже отстримлен в ленту: уведомляем потребителей
   * (`retract`), чтобы убрать его до переответа — иначе финал встанет дублем.
   * Плюс пишем `claim_retry` в сессию (иначе llm_usage без assistant — дырка).
   */
  private retractDraft(deps: HallucinationGateDeps, kind: string, reason: string): void {
    deps.onMeta?.(t("ui.draft_retracted"), "retract");
    deps.slog?.logClaimRetry({ kind, reason, iteration: deps.state.iteration });
  }

  /**
   * Общий инжект claim-повтора: фиксирует отклонённый ответ, дописывает
   * причину как `<system-summary>` и просит цикл о следующем ходе.
   */
  private retryClaim(
    deps: HallucinationGateDeps,
    textContent: string | undefined,
    reason: string,
    logLine: string,
    kind: string,
  ): HallucinationVerdict {
    const { state, logger } = deps;
    state.iterHallucinationRetry = true;
    // Переответ пересказывает выполненную задачу и естественно повторяется —
    // бюджет халлюцинаций на его форму не жжём (та же логика, что даунгрейд
    // в applyRetry после отклонения аудита).
    state.suppressRepetitionRetry = true;
    logger.diagnostic("warn", logLine);
    this.retractDraft(deps, kind, reason);
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