/**
 * Финальные гейты итерации (`TurnCoordinator`, INV-23): hallucination → critic →
 * audit, плюс guard пустого ответа и трекинг решений. Вынесено из `core/agent.ts`.
 *
 * Запускается только на итерации БЕЗ тулов (ветка с тулами уходит на `continue`
 * раньше). Управляющий поток возвращается сигналом.
 */
import type { AgentDeps } from "../agent";
import type { AgentResult, OnMeta } from "../types";
import type { LoopState } from "./loop-state";
import type { SessionLogger } from "../session-logger";
import type { HallucinationGate } from "./hallucination-gate";
import type { CriticGate } from "./critic-gate";
import type { AuditGate } from "./audit-gate";
import type { DraftSink } from "./draft-buffer";
import { gatherTurnToolEvents } from "./critic-events";
import { resolveArtifactStates } from "./artifact-resolve";
import { resolveVerbosity } from "../../ui/theme";
import { MAX_EMPTY_RESPONSE_RETRIES } from "./constants";

/** AQC-3: сколько раз просим повторить проверку после её деградации. */
const MAX_CRITIC_DEGRADED_RETRIES = 1;
import { t } from "../../i18n/index";
import { checkBlockedClaim, collectBlockedResults } from "./blocked-claim-gate";

/** Итог гейтов: сигнал для петли. */
export type GatesOutcome =
  | { kind: "ok" } // гейты пройдены, ход продолжается (след. итерация)
  | { kind: "continue" }
  | { kind: "break" }
  | { kind: "return"; result: AgentResult };

/**
 * Сколько ход простоял в каждом гейте (мс). Заполняется по ходу: при раннем
 * возврате (блокировка галлюцинацией) часть полей остаётся пустой — это и есть
 * честная картина, а не нули (A15).
 */
export interface GateTimings extends Record<string, number | undefined> {
  hallucination?: number;
  critic?: number;
  audit?: number;
}

/** Входные данные финальных гейтов одной итерации (без тулов). */
export interface GatesInput {
  state: LoopState;
  textContent: string;
  reasoningContent: string;
  input: string;
  slog: SessionLogger;
  onChunk?: (chunk: string) => void;
  onMeta?: OnMeta;
  hallucinationGate: HallucinationGate;
  criticGate: CriticGate;
  auditGate: AuditGate;
  /** Куда сложить длительности гейтов (A15); без него — не измеряем. */
  timings?: GateTimings;
  /** Пользователь прервал ход: после критика не гоняем аудит. */
  isShutdownRequested?: () => boolean;
  /** Буфер черновика (`ui.draftMode: after-review`); live-режим — no-op. */
  draft?: DraftSink;
}

/** Прогоняет hallucination/critic/audit и возвращает сигнал управления. */
export async function runFinalGates(host: AgentDeps, inp: GatesInput): Promise<GatesOutcome> {
  const { contextManager, logger, hallucinationDetector, config } = host;
  const { state, textContent, reasoningContent, input, slog, onChunk, onMeta } = inp;
  const timings = inp.timings;

  const hallucinationStarted = Date.now();
  const verdict = await inp.hallucinationGate.evaluate({
    state,
    textContent,
    input,
    exitOnComplete: host.exitOnComplete ?? false,
    hasFinalAudit: !!host.finalAudit,
    logger,
    contextManager,
    onMeta,
    onChunk,
    // Строка о неуверенности — диагностика: только verbose-режим.
    verbose: resolveVerbosity(host.config.ui) === "verbose",
    // Заземление заявлений на диск. Резолвится здесь — у гейта нет fs.
    artifacts: resolveArtifactStates(host.baseDir, textContent),
    slog,
    // INV-15: деградация проверки заявлений обязана дойти до сессии, иначе
    // «claim проверен» и «проверять было нечем» неразличимы.
    onDiagnostic: host.onDiagnostic,
  });
  if (timings) timings.hallucination = Date.now() - hallucinationStarted;
  // Прерванный ход не должен дальше тратить LLM-вызовы на критика/аудит.
  if (inp.isShutdownRequested?.()) {
    inp.draft?.discard();
    return { kind: "break" };
  }
  if (verdict.action === "block") {
    inp.draft?.discard();
    return {
      kind: "return",
      result: {
        success: false,
        text: state.lastText,
        error: t("error.response_blocked", { reason: verdict.reason }),
        iterationCount: state.iteration,
      },
    };
  }
  if (verdict.action === "retry") {
    inp.draft?.discard();
    return { kind: "continue" };
  }
  if (verdict.action === "exit") {
    inp.draft?.flush();
    return { kind: "break" };
  }
  // warn/accept → принятие ответа

  // Assistant message stays in the in-memory context for the critic's repair
  // round, but session history/log are written only after acceptance below.
  if (textContent) {
    contextManager.addMessage({ role: "assistant", content: textContent });
  }
  state.lastText = textContent;
  const recordAccepted = (): void => {
    if (!textContent) return;
    if (config.session.autoSave) slog.saveAssistantMessage(textContent);
    slog.logAssistant(
      textContent,
      reasoningContent,
      undefined,
      state.iteration,
      state.lastFinishReason,
    );
  };

  for (const match of textContent.matchAll(
    /(?:plan|decided|decision|решено|план|решение):\s*(.+?)(?:\n|$)/gi,
  )) {
    hallucinationDetector.getConsistencyCheck().trackDecision(match[1].trim(), "agent_response");
  }

  // Guard: пустой финальный ответ. Подталкиваем к реальному ответу вместо
  // молчаливого завершения с text: "".
  if (!textContent?.trim()) {
    if (state.emptyResponseRetries < MAX_EMPTY_RESPONSE_RETRIES) {
      state.emptyResponseRetries++;
      logger.diagnostic(
        "warn",
        `Empty response on iteration ${state.iteration} (retry ${state.emptyResponseRetries}/${MAX_EMPTY_RESPONSE_RETRIES})`,
      );
      contextManager.addMessage({
        role: "user",
        content:
          "<system-summary>Your previous response was empty. Answer the user's task now with a final text response or call a tool. Do not reply with reasoning only.</system-summary>",
      });
      inp.draft?.discard();
      return { kind: "continue" };
    }
    state.emptyResponseExhausted = true;
    logger.diagnostic(
      "warn",
      `Empty response retries exhausted after ${MAX_EMPTY_RESPONSE_RETRIES} attempts`,
    );
  }

  const criticStarted = Date.now();
  const criticAction = await inp.criticGate.evaluate({
    state,
    iteration: state.iteration,
    logger,
    contextManager,
    slog,
    task: input,
    baseDir: host.baseDir,
    planSummary: host.planSummary?.() ?? undefined,
    planPendingSteps: host.planPendingSteps?.() ?? undefined,
    toolEvents: gatherTurnToolEvents(contextManager, state.criticHistoryMark),
    beforeFinish: true,
    // Текст ответа нужен критику и после мутаций: read-only bash/read_file
    // инкрементят mutationsSinceCritic, и раньше ANSWER пропадал — критик
    // писал «answer/conclusion not delivered» при корректном ответе.
    answerText: textContent.trim() ? textContent : undefined,
    onMeta,
  });
  if (timings) timings.critic = Date.now() - criticStarted;
  // Остановка во время критика: аудит — ещё один LLM-вызов, его пропускаем.
  if (inp.isShutdownRequested?.()) {
    inp.draft?.discard();
    return { kind: "break" };
  }
  // AQC-3: деградированная проверка на шаге с check не равна «ок». Один раз
  // просим модель повторить шаг с проверкой; дальше — честный fail-open с
  // записью в лог, чтобы не уйти в бесконечный retry.
  if (criticAction === "degraded") {
    if (state.criticDegradedCycles < MAX_CRITIC_DEGRADED_RETRIES) {
      state.criticDegradedCycles++;
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("critic.degraded_retry")}</system-summary>`,
      });
      state.suppressRepetitionRetry = true;
      inp.draft?.discard();
      return { kind: "continue" };
    }
    logger.diagnostic(
      "warn",
      "Critic degraded retries exhausted — accepting answer without verification",
    );
  }
  if (criticAction === "retry") {
    state.suppressRepetitionRetry = true;
    inp.draft?.discard();
    return { kind: "continue" };
  }

  // BCP-2: один раз заставляем процитировать каноничную подсказку блокировки.
  const blocked = checkBlockedClaim(
    textContent,
    collectBlockedResults(contextManager.getActiveHistory()),
  );
  if (blocked.reanswer && state.blockedClaimCycles < 1 && blocked.canonical) {
    state.blockedClaimCycles++;
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("blocked.claim_reanswer", { canonical: blocked.canonical })}</system-summary>`,
    });
    state.suppressRepetitionRetry = true;
    inp.draft?.discard();
    return { kind: "continue" };
  }

  const auditStarted = Date.now();
  const auditVerdict = await inp.auditGate.evaluate({
    state,
    iteration: state.iteration,
    maxIterations: config.maxToolIterations,
    logger,
    contextManager,
    slog,
    onMeta,
  });
  if (timings) timings.audit = Date.now() - auditStarted;
  if (auditVerdict === null || auditVerdict.action === "pass") {
    inp.draft?.flush();
    recordAccepted();
    state.finalAnswerAccepted = true;
    return { kind: "break" };
  }
  if (auditVerdict.action === "exhausted") {
    // auditFailed already set by the audit gate; the text is the last accepted
    // candidate, so show it together with the error.
    inp.draft?.flush();
    recordAccepted();
    return { kind: "break" };
  }
  inp.draft?.discard();
  return { kind: "ok" };
}
