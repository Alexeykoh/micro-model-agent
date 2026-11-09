/**
 * Побочные эффекты вызова тула: заглушки прерванных вызовов, трекинг файлов
 * консистентности, скрипт-обход и персист ассетов.
 *
 * Вынесено из `tool-batch.ts` (правило 6): функции не знают о порядке пакета.
 */
import type { AppConfig } from "../../config/types";
import type { ContextManager } from "../../core/context/manager";
import type { Logger } from "../../logger/app-logger";
import type { ToolResult } from "../../tools/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import type { ToolBatchDeps } from "./tool-batch";
import type { ToolCall } from "../types";
import { isExecutableScriptPath } from "./tool-output";

/**
 * Досылает `role:"tool"`-заглушки для вызовов, не получивших результат
 * (прерывание/abort): OpenAI-совместимые Jinja-шаблоны отклоняют историю, где
 * assistant(tool_calls) не завершён на каждый call id.
 */
export function emitSynthesizedToolResults(
  contextManager: ContextManager,
  toolCalls: ToolCall[],
  answered: Set<string>,
  logger: Logger,
): void {
  for (const call of toolCalls) {
    if (answered.has(call.id)) continue;
    logger.debug(
      `Interrupted before tool ${call.name} (${call.id}) returned a result — synthesizing tool message`,
    );
    contextManager.addMessage({
      role: "tool",
      content: "[interrupted]",
      name: call.name,
      tool_call_id: call.id,
      success: false,
      arguments: call.arguments,
    });
  }
}

/** Побочные эффекты успешного тула: план create/re-plan и трекинг файлов. */
export function trackToolResultSideEffects(
  deps: ToolBatchDeps,
  state: LoopState,
  call: ToolCall,
  result: ToolResult,
): void {
  if (!result.success) return;
  if (call.name === "plan") {
    const action = String(call.arguments.action ?? "");
    if (action === "create" || action === "re-plan") state.iterPlanCreated = true;
  }
  if (!call.arguments.path) return;
  const filePath = String(call.arguments.path);
  if (call.name === "write_file" || call.name === "edit_file") {
    deps.hallucinationDetector.getConsistencyCheck().trackCreatedFile(filePath);
  } else if (call.name === "delete_file") {
    deps.hallucinationDetector.getConsistencyCheck().trackDeletedFile(filePath);
  }
}

/**
 * После отказа `write_file` на размер куска (INV-H2) следующий LLM-вызов идёт
 * с повышенным бюджетом, чтобы модель успела разбить файл на несколько
 * `append_file`-кусков без обрыва по reasoning. Фактически вызывающий
 * `state.iterMaxTokensOverride` поднимается один раз на отказ.
 */
export function bumpBudgetAfterWriteTooLarge(
  state: LoopState,
  call: ToolCall,
  result: ToolResult,
): void {
  if (call.name !== "write_file" || result.success) return;
  const out = typeof result.output === "string" ? result.output : "";
  if (!/too large|слишком большое|too_large/i.test(out)) return;
  const prev = state.iterMaxTokensOverride ?? 8192;
  state.iterMaxTokensOverride = Math.min(
    Math.max(prev, 16384),
    32000,
  );
}

/**
 * Запоминает `[SECURITY BLOCKED]` и сообщает, нужно ли добавить nudge против
 * записи shell-скрипта-обхода (после блока запись .bat/.cmd/.sh/.ps1 — почти
 * всегда попытка обойти заблокированный оператор; один раз, обобщённо).
 */
export function detectScriptWorkaround(
  state: LoopState,
  call: ToolCall,
  result: ToolResult,
): boolean {
  if (typeof result.output === "string" && result.output.includes("[SECURITY BLOCKED]")) {
    state.sawSecurityBlock = true;
  }
  if (
    state.sawSecurityBlock &&
    !state.scriptWorkaroundNudged &&
    call.name === "write_file" &&
    typeof call.arguments.path === "string" &&
    isExecutableScriptPath(call.arguments.path)
  ) {
    state.scriptWorkaroundNudged = true;
    return true;
  }
  return false;
}

/**
 * Персистит полноразмерные ассеты тула (web replay) и проставляет `imageRefs`.
 * Шифрованная сессия / нет сессии → refs пусты (forwarder сделает inline-фолбэк).
 */
export function persistResultImages(
  slog: SessionLogger | undefined,
  result: ToolResult,
  config: AppConfig,
): void {
  if (!slog || !result.imageFiles?.length) return;
  const refs = slog.persistToolImages(result.imageFiles, {
    maxCount: config.images?.maxCount ?? 30,
    maxBytes: config.images?.maxBytes ?? 104_857_600,
  });
  if (refs.length) result.imageRefs = refs;
}
