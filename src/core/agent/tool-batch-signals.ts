/**
 * Recovery-сигналы после пакета тулов: серии неудач, повторов, веб-разведки,
 * окно фейлов и молчание. Вынесено из `tool-batch.ts` (правило 6): функция
 * применяет блоки строго в исходном порядке и возвращает терминальный
 * `finalize`, если петля должна выйти; иначе `{}` — цикл продолжается.
 */
import { t } from "../../i18n/index";
import type { ContextManager } from "../../core/context/manager";
import type { Logger } from "../../logger/app-logger";
import type { SessionLogger } from "../session-logger";
import type { StopReason, ToolCall } from "../types";
import type { MemoryStore } from "../../modules/memory/store";
import type { LoopState } from "./loop-state";
import { recordBatchProgress } from "./loop-state";
import {
  HARD_STOP_DUPLICATE_BATCHES,
  HARD_STOP_FAILED_BATCHES,
  HARD_STOP_SILENT_BATCHES,
  MAX_CONSECUTIVE_FAILED_BATCHES,
  MAX_CONSECUTIVE_TOOL_FAILURES,
  MAX_DUPLICATE_BATCHES,
  MAX_FAILED_BATCHES_PER_TURN,
  MAX_RESEARCH_BATCHES,
  MIN_NARRATION_CHARS,
  NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES,
  RECOVERY_DIRECTIVE_REFRESH,
  RECOVERY_MEMORY_RULE_REFRESH,
  STALL_FAILURES_IN_WINDOW,
  STALL_WINDOW,
} from "./constants";
import { clearDirective, issueDirective } from "./directives";
import { resetSilenceStreak } from "./silence-streak";
import { canonicalArgsKey } from "./canonical-args";
import { countDistinctFailingTools } from "./failure-memory";

/**
 * Внешние веб-тулы: пакет только из них — «веб-разведка». Длинная серия таких
 * пакетов без единого не-web действия питает одноразовую директиву «сведи к
 * результату» (`MAX_RESEARCH_BATCHES`). Набор узкий (внешние запросы, не чтение
 * локального кода), поэтому легитимный локальный анализ не задевает.
 */
const RESEARCH_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "web_browse",
  "browser",
  "download_file",
]);

/**
 * Тулы опроса фоновых процессов: повтор с теми же аргументами — легитимное
 * ожидание (`process_wait` и опрос `process_log`), а не дубль-петля. Пакет
 * только из них не питает duplicate-стрик.
 */
const POLL_TOOLS = new Set(["process_log", "process_wait"]);

/** Входные данные оценки пакета: состояние петли и итоги вызовов. */
export interface BatchSignalsInput {
  state: LoopState;
  contextManager: ContextManager;
  logger: Logger;
  slog: SessionLogger | undefined;
  input: string;
  textContent: string;
  toolCalls: ToolCall[];
  anyToolFailed: boolean;
  batchHasSuccess: boolean;
  /** Хранилище правил памяти (undefined — модуль памяти выключен). */
  memoryStore: MemoryStore | undefined;
}

/** Терминальный сигнал петли, если батч требует финализации. */
export interface BatchSignalsResult {
  finalize?: Exclude<StopReason, "max_iters">;
}

/** Применяет recovery-сигналы пакета в порядке приоритета. */
export function applyBatchSignals(inp: BatchSignalsInput): BatchSignalsResult {
  const { state, contextManager, logger, slog, input, textContent, toolCalls } = inp;
  const { anyToolFailed, batchHasSuccess } = inp;

  // Последовательные неудачи: recovery-сообщение + правило в память.
  if (anyToolFailed) {
    state.consecutiveToolFailures++;
    state.consecutiveToolSuccesses = 0;
  } else {
    state.consecutiveToolFailures = 0;
    state.consecutiveToolSuccesses++;
    // Серия фейлов закончилась — директива восстановления больше не нужна.
    clearDirective(contextManager, "consecutive_failures");
  }
  if (state.consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
    logger.diagnostic("warn", `Consecutive tool failures: ${state.consecutiveToolFailures}`);
    // Директива и правило в память — не на каждый батч: инжект на каждом пакете
    // давал до ~190 дублей за ход, а запись мутировала память ⇒ рвался prompt-cache (§1.6 аудита).
    const directiveDue =
      state.iteration - state.lastRecoveryDirectiveIteration >= RECOVERY_DIRECTIVE_REFRESH;
    if (directiveDue) {
      state.lastRecoveryDirectiveIteration = state.iteration;
      const recoveryMsg = t("exec.consecutive_failures_recovery", {
        count: state.consecutiveToolFailures,
      });
      const taskSnippet = input.length > 200 ? `${input.slice(0, 200)}...` : input;
      const taskReminder = t("exec.task_reminder", { task: taskSnippet });
      issueDirective(contextManager, "consecutive_failures", `${recoveryMsg}\n${taskReminder}`);
    }

    const memStore = inp.memoryStore;
    const memoryDue =
      state.iteration - state.lastRecoveryMemoryRuleIteration >= RECOVERY_MEMORY_RULE_REFRESH;
    // «Systemic» — только когда падают ≥3 разных тула, а не одна команда.
    if (memStore && memoryDue && countDistinctFailingTools(state) >= 3) {
      state.lastRecoveryMemoryRuleIteration = state.iteration;
      memStore.appendRule(
        "errors",
        `${state.consecutiveToolFailures} consecutive tool failures`,
        "Multiple tools failing suggests environment or configuration issue",
        "Check dependencies, verify file paths, try write_file directly instead of shell commands",
      );
    }
  }

  // Honest-stop полностью провальных пакетов: каждый вызов пакета — неудача
  // или tool-level блок (в отличие от consecutiveToolFailures выше, блоки
  // ВХОДЯТ в учёт — перебор вариантов заблокированной команды это та же
  // петля). Смешанные пакеты и успехи сбрасывают стрик: связка
  // «упал → поправил → упал» (дебаг) под него не попадает.
  // Plugin-level блоки (result.blocked, guard-rails) — не успех, но для
  // honest-stop это неудача: серия отказов гарда без прогресса тоже петля.
  if (anyToolFailed && !batchHasSuccess) {
    state.consecutiveFailedBatches++;
  } else if (batchHasSuccess) {
    state.consecutiveFailedBatches = 0;
    state.honestStopNudged = false;
    clearDirective(contextManager, "failed_batches");
  }
  if (
    state.consecutiveFailedBatches >= MAX_CONSECUTIVE_FAILED_BATCHES &&
    !state.honestStopNudged
  ) {
    state.honestStopNudged = true;
    logger.diagnostic(
      "warn",
      `Consecutive failed tool batches: ${state.consecutiveFailedBatches} — honest-stop directive`,
    );
    issueDirective(
      contextManager,
      "failed_batches",
      t("exec.honest_stop", { count: state.consecutiveFailedBatches }),
    );
  }
  if (state.consecutiveFailedBatches >= HARD_STOP_FAILED_BATCHES) {
    logger.diagnostic(
      "warn",
      `Retry loop terminated after ${state.consecutiveFailedBatches} consecutive failed batches — forcing final answer`,
    );
    return { finalize: "failed_batches" };
  }

  // Duplicate-бюджет: серия пакетов, где КАЖДЫЙ вызов дословно повторяет уже
  // сделанный за ход (канонический ключ). Широкая разведка новыми файлами и
  // паттернами прогрессирует — стрик не набирает. Опрос процесса
  // (process_log/process_wait) — легитимный повтор, стрик не питает.
  const isPurePoll = toolCalls.length > 0 && toolCalls.every((c) => POLL_TOOLS.has(c.name));
  const keys = toolCalls.map((c) => canonicalArgsKey(c.name, c.arguments));
  const isDuplicateBatch =
    !isPurePoll && toolCalls.length > 0 && keys.every((k) => state.seenToolCalls.has(k));
  recordBatchProgress(state, keys, isDuplicateBatch);

  if (isDuplicateBatch) {
    state.consecutiveDuplicateBatches++;
  } else {
    state.consecutiveDuplicateBatches = 0;
    state.duplicateNudged = false;
    clearDirective(contextManager, "duplicate");
  }
  if (state.consecutiveDuplicateBatches >= MAX_DUPLICATE_BATCHES && !state.duplicateNudged) {
    state.duplicateNudged = true;
    logger.diagnostic(
      "warn",
      `Duplicate tool-call streak: ${state.consecutiveDuplicateBatches} batches — directive`,
    );
    issueDirective(
      contextManager,
      "duplicate",
      t("exec.readonly_directive", { count: state.consecutiveDuplicateBatches }),
    );
  }
  if (state.consecutiveDuplicateBatches >= HARD_STOP_DUPLICATE_BATCHES) {
    logger.diagnostic(
      "warn",
      `Duplicate loop terminated after ${state.consecutiveDuplicateBatches} identical batches — forcing final answer`,
    );
    return { finalize: "duplicate" };
  }

  // Веб-разведка без результата: серия пакетов, целиком из внешних веб-тулов.
  // Только директива (без жёсткого стопа) — «сведи поиск к результату».
  const isResearchBatch = toolCalls.length > 0 && toolCalls.every((c) => RESEARCH_TOOLS.has(c.name));
  if (isResearchBatch) {
    state.consecutiveResearchBatches++;
    state.nonResearchBatchesWithResult = 0;
  } else if (batchHasSuccess) {
    // Посторонний успешный не-web батч НЕ обнуляет серию сразу: иначе
    // `web_search → read_file → web_fetch → read_file` не набирает порог и
    // директива выдаётся заново бесконечно (§1.4 аудита). Снимаем серию
    // только после двух подряд не-web батчей с результатом — это признак,
    // что модель действительно ушла от поиска.
    state.nonResearchBatchesWithResult++;
    if (state.nonResearchBatchesWithResult >= 2) {
      state.consecutiveResearchBatches = 0;
      state.researchNudged = false;
      clearDirective(contextManager, "research");
    }
  }
  if (state.consecutiveResearchBatches >= MAX_RESEARCH_BATCHES && !state.researchNudged) {
    state.researchNudged = true;
    logger.diagnostic(
      "warn",
      `Web-research streak: ${state.consecutiveResearchBatches} batches without a result — directive`,
    );
    issueDirective(
      contextManager,
      "research",
      t("exec.research_convergence", { count: state.consecutiveResearchBatches }),
    );
  }

  // Окно неудач: чередование «успех + фейл» не набирает ни
  // consecutiveFailedBatches (сбрасывается успехом), ни consecutiveToolFailures.
  // В ses_mvpdchvi это дало 29 отказов из 98 пакетов без единой эскалации —
  // единственной реакцией было отключение bash.
  state.recentBatchFailures.push(anyToolFailed);
  if (state.recentBatchFailures.length > STALL_WINDOW) state.recentBatchFailures.shift();
  if (anyToolFailed) state.failedBatchesTotal++;
  const failuresInWindow = state.recentBatchFailures.filter(Boolean).length;
  if (failuresInWindow < STALL_FAILURES_IN_WINDOW) state.stallNudged = false;
  if (failuresInWindow >= STALL_FAILURES_IN_WINDOW && !state.stallNudged) {
    state.stallNudged = true;
    const cause = `${failuresInWindow}/${STALL_WINDOW} failed batches, ${state.failedBatchesTotal} total`;
    logger.diagnostic("warn", `Stall window: ${cause} — directive`);
    slog?.logDiagnosticEvent("stall_detected", {
      source: "core",
      operation: "tool_batch.stall",
      kind: "failed",
      cause,
    });
    issueDirective(
      contextManager,
      "stalled",
      t("exec.stall_directive", {
        count: String(failuresInWindow),
        window: String(STALL_WINDOW),
        total: String(state.failedBatchesTotal),
      }),
    );
  }
  if (state.failedBatchesTotal >= MAX_FAILED_BATCHES_PER_TURN) {
    logger.diagnostic(
      "warn",
      `Stall terminal: ${state.failedBatchesTotal} failed batches in one turn — forcing final answer`,
    );
    return { finalize: "stalled" };
  }

  // Нарратив: серия пакетов без единого слова пользователю. Модель, ушедшая
  // в молчаливые вызовы, для пользователя неотличима от зависшего процесса
  // (в ses_mvpdchvi 98 шагов подряд прошли без текста, ход дважды прерван).
  const said = textContent.trim().length >= MIN_NARRATION_CHARS;
  if (said) {
    resetSilenceStreak(state, contextManager);
  } else {
    state.consecutiveSilentBatches++;
  }
  if (
    state.consecutiveSilentBatches >= NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES &&
    !state.narrationNudged
  ) {
    state.narrationNudged = true;
    logger.diagnostic(
      "warn",
      `Silent tool batches: ${state.consecutiveSilentBatches} without assistant text — narration directive`,
    );
    issueDirective(
      contextManager,
      "narration",
      t("exec.narration_directive", { count: String(state.consecutiveSilentBatches) }),
    );
  }
  if (state.consecutiveSilentBatches >= HARD_STOP_SILENT_BATCHES) {
    logger.diagnostic(
      "warn",
      `Silent loop terminated after ${state.consecutiveSilentBatches} batches without text — forcing final answer`,
    );
    return { finalize: "silent" };
  }

  return {};
}
