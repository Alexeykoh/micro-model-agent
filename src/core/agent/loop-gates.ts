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
import { gatherTurnToolEvents } from "./critic-events";
import { resolveArtifactStates } from "./artifact-resolve";
import { resolveVerbosity } from "../../ui/theme";
import { MAX_EMPTY_RESPONSE_RETRIES } from "./constants";
import { t } from "../../i18n/index";

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
  if (verdict.action === "block") {
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
  if (verdict.action === "retry") return { kind: "continue" };
  if (verdict.action === "exit") return { kind: "break" };
  // warn/accept → принятие ответа

  if (textContent) {
    contextManager.addMessage({ role: "assistant", content: textContent });
    if (config.session.autoSave) slog.saveAssistantMessage(textContent);
    slog.logAssistant(
      textContent,
      reasoningContent,
      undefined,
      state.iteration,
      state.lastFinishReason,
    );
  }
  state.lastText = textContent;

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
    planSummary: host.planSummary?.() ?? undefined,
    toolEvents: gatherTurnToolEvents(contextManager, state.criticHistoryMark),
    beforeFinish: true,
    // Текст ответа — только для ходов без мутаций (чат-доставка).
    answerText: state.mutationsSinceCritic === 0 ? textContent : undefined,
    onMeta,
  });
  if (timings) timings.critic = Date.now() - criticStarted;
  if (criticAction === "retry") {
    state.suppressRepetitionRetry = true;
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
    state.finalAnswerAccepted = true;
    return { kind: "break" };
  }
  if (auditVerdict.action === "exhausted") {
    // auditFailed уже выставлен вентилем.
    return { kind: "break" };
  }
  return { kind: "ok" };
}
