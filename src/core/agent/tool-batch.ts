/** Исполнитель пакета тулов: жизненный цикл вызовов за итерацию. */
import { t } from "../../i18n/index";
import type { AppConfig } from "../../config/types";
import type { ContextManager } from "../../core/context/manager";
import type { HallucinationDetector } from "../../core/hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { MemoryStore } from "../../modules/memory/store";
import type { PluginManager } from "../../modules/plugins/manager";
import type { CostTracker } from "../../modules/pricing/index";
import type { ToolExecutor } from "../../tools/executor";
import type { SessionLogger } from "../session-logger";
import type { ToolCall, ToolEvent } from "../types";
import type { OnMeta, StopReason } from "../types";
import type { ToolResult } from "../../tools/types";
import { recordBatchProgress, type LoopState } from "./loop-state";
import {
  summarizeToolArgs,
  truncateToolOutput,
  isExecutableScriptPath,
  appendErrorMeta,
} from "./tool-output";
import { queueToolImages } from "./tool-images";
import { errMsg } from "../../utils";
import type { CompactionService } from "./compaction";
import { MAX_CONSECUTIVE_TOOL_FAILURES, MAX_CONSECUTIVE_FAILED_BATCHES, HARD_STOP_FAILED_BATCHES, MAX_DUPLICATE_BATCHES, HARD_STOP_DUPLICATE_BATCHES, MAX_RESEARCH_BATCHES, RECOVERY_DIRECTIVE_REFRESH, RECOVERY_MEMORY_RULE_REFRESH, NARRATION_DIRECTIVE_AFTER_SILENT_BATCHES, HARD_STOP_SILENT_BATCHES, MIN_NARRATION_CHARS, STALL_WINDOW, STALL_FAILURES_IN_WINDOW, MAX_FAILED_BATCHES_PER_TURN } from "./constants";
import { clearDirective, issueDirective } from "./directives";
import { canonicalArgsKey } from "./canonical-args";
import { countDistinctFailingTools, recordRepeatedToolFailure } from "./failure-memory";

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

/** Дефолтный кап конкурентных тулов одного batch'а (см. security.rateLimits). */
const DEFAULT_MAX_PARALLEL_TOOLS = 5;

/**
 * Тулы опроса фоновых процессов: повтор с теми же аргументами — легитимное
 * ожидание (`process_wait` и опрос `process_log`), а не дубль-петля. Пакет
 * только из них не питает duplicate-стрик.
 */
const POLL_TOOLS = new Set(["process_log", "process_wait"]);

/**
 * Прогоняет `fn` по `items` с лимитом одновременных запусков, сохраняя порядок
 * результатов (results[i] соответствует items[i]). Пул воркеров, а не
 * `Promise.all` пачками — ровный кап без простоя. `fn` наружу release-хуков не
 * требует; если он бросит, промис отклонится (как serial `await`).
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const effective = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: effective }, () => worker()));
  return results;
}

/** Зависимости исполнителя пакетов: конфиг, тулы, контекст, логгеры, хуки. */
export interface ToolBatchDeps {
  config: AppConfig;
  toolExecutor: ToolExecutor;
  pluginManager: PluginManager;
  contextManager: ContextManager;
  hallucinationDetector: HallucinationDetector;
  compactionService: CompactionService;
  logger: Logger;
  memoryStore: MemoryStore | undefined;
  costTracker: CostTracker;
  /** Статусная строка активного плана для <system-summary>. */
  planSummary: (() => string | null) | undefined;
  /** Текущий AbortSignal (для прерывания тула). */
  getAbortSignal: () => AbortSignal | undefined;
  /** Идёт ли сейчас shutdown (Esc/Ctrl+C). */
  isShutdownRequested: () => boolean;
  /** Переустановка tool scope перед каждым вызовом тула. */
  setScope: () => void;
}

/** Итог пакета: прервана ли итерация по shutdown (цикл должен выйти). */
export interface ToolBatchExecution {
  /** Истинно, если итерация прервана по shutdown — цикл должен выйти. */
  interrupted: boolean;
  /** Терминал: цикл должен выйти и форсировать финальный ответ без тулов. */
  finalize?: Exclude<StopReason, "max_iters">;
}

/**
 * Выполнение пакета тулов, полученных от модели за одну итерацию.
 *
 * Отвечает за весь жизненный цикл тула:
 * - запись assistant-сообщения с tool_calls в контекст и session log;
 * - plugin-хуки (onToolCall, onToolStart, onToolEnd, onMeta);
 * - событий UI (onTool start/end), вывод display/diff;
 * - усечение результата под бюджет и запись role:"tool" сообщения;
 * - синтез "[interrupted]" результатов для тулов без ответа (иначе
 *   OpenAI-совместимые бэкенды отклоняют историю HTTP 400);
 * - учёт неудач (последовательные + общие по тулам) и запись правил в память;
 * - инъекцию <system-summary> с результатами и статусом плана.
 *
 * Не знает о структуре цикла — возвращает флаг `interrupted`, решение о
 * `break`/`continue` принимает вызывающий цикл.
 */

export {
  diagnoseRepeatedFailures,
  type RepeatedFailureDiagnosis,
} from "./failure-diagnosis";
/** Информационные read-only тулы, чей "фейл" — ожидаемое поведение. */
const INFO_TOOLS = new Set(["file_info"]);

/**
 * Досылает `role:"tool"`-заглушки для вызовов, не получивших результат
 * (прерывание/abort): OpenAI-совместимые Jinja-шаблоны отклоняют историю, где
 * assistant(tool_calls) не завершён на каждый call id.
 */
function emitSynthesizedToolResults(
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

/**
 * Рендер model-facing тела/диффа тула в чат. kind="tool" — quiet-чаты скрывают
 * тела тулов; статусные меты остаются видимы. display имеет приоритет, иначе
 * прогон через onMeta; упавший тул показывает спокойную суть, не директивы.
 */
import { imageEventFields, renderToolResultMeta } from "./tool-result-meta";

/** Побочные эффекты успешного тула: план create/re-plan и трекинг файлов. */
function trackToolResultSideEffects(
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
 * Запоминает `[SECURITY BLOCKED]` и сообщает, нужно ли добавить nudge против
 * записи shell-скрипта-обхода (после блока запись .bat/.cmd/.sh/.ps1 — почти
 * всегда попытка обойти заблокированный оператор; один раз, обобщённо).
 */
function detectScriptWorkaround(state: LoopState, call: ToolCall, result: ToolResult): boolean {
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
function persistResultImages(
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

/** Поля изображений для `ToolEvent.end`: refs, иначе inline-фолбэк, иначе ничего. */

export class ToolBatchExecutor {  constructor(private readonly deps: ToolBatchDeps) {}

  /**
   * Выполняет пакет tool_calls одной итерации (контекст, UI, учёт неудач).
   * @param state состояние цикла; @param toolCalls вызовы от модели;
   * @param boundedToolNames тулы с собственным лимитом вывода;
   * @param textContent/reasoningContent/input тексты хода;
   * @returns флаг прерывания по shutdown.
   */
  async execute(
    state: LoopState,
    toolCalls: ToolCall[],
    boundedToolNames: Set<string>,
    textContent: string,
    reasoningContent: string,
    input: string,
    onTool?: (ev: ToolEvent) => void,
    onMeta?: OnMeta,
    slog?: SessionLogger,
  ): Promise<ToolBatchExecution> {
    const { config, pluginManager, contextManager, logger } = this.deps;
    const iteration = state.iteration;

    slog?.logAssistant(textContent || "", reasoningContent, toolCalls, iteration);

    contextManager.addMessage({
      role: "assistant",
      content: textContent || "",
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    });

    const answeredToolCallIds = new Set<string>();
    // OpenAI-совместимые бэкенды (Jinja-шаблоны llama.cpp) отклоняют HTTP 400
    // любую историю, где assistant(tool_calls) не завершён role:"tool"
    // результатами для каждого call id — прерывание на середине пакета не
    // должно оставлять висящую пару.
    const synthesizePendingToolResults = (): void =>
      emitSynthesizedToolResults(contextManager, toolCalls, answeredToolCallIds, logger);

    const summaries: string[] = [];
    let anyToolFailed = false;
    let batchHasSuccess = false;
    // `sawSecurityBlock` живёт весь ход (LoopState создаётся на ход): сброс на
    // каждом батче не давал поймать «bash заблокирован → write_file *.sh» в
    // следующем батче (§1.8 аудита).

    // ── Общие шаги жизненного цикла вызова: serial и parallel путь делят их. ──

    /** До выполнения: сброс scope, hook-и вызова, UI-старт, запись вызова. */
    const prepareCall = (call: ToolCall): void => {
      this.deps.setScope();
      pluginManager.runOnToolCall({
        toolName: call.name,
        args: call.arguments,
      });
      pluginManager.runOnToolStart(
        { iteration, logger, contextManager },
        { id: call.id, name: call.name, arguments: call.arguments },
      );
      const toolIcon = this.deps.toolExecutor.getRegistry().get(call.name)?.icon;
      onTool?.({ type: "start", tool: call.name, args: call.arguments, callId: call.id, icon: toolIcon });
      slog?.logToolCall(call, iteration);
    };

    /**
     * Выполнение хендлера (allowlist/плагины/таймаут — внутри executor'а).
     * `shutdown: true` — итерация прервана (Esc/Ctrl+C): вызывающий выходит,
     * не рендеря результат.
     */
    const executeCall = async (
      call: ToolCall,
      executor: ToolExecutor,
    ): Promise<{
      result: ToolResult;
      duration: number;
      tokensBeforeTool: number;
      costBeforeTool: number | undefined;
      shutdown: boolean;
    }> => {
      const startTime = Date.now();
      const tokensBeforeTool = contextManager.getEstimatedTokens();
      // Снимок стоимости ДО тула: рендеру нужна стоимость именно этого вызова
      // (subagent/mcp/pipeline тратят токены), а не накопленная за сессию.
      const costBeforeTool = this.deps.costTracker.total;
      let result: ToolResult;
      try {
        result = await executor.execute(call, this.deps.getAbortSignal());
      } catch (err) {
        // Abort во время тула должен распространяться, чтобы сессия завершилась
        // чисто. Любой ДРУГОЙ throw (баг тула/плагина, сбежавший из executor)
        // не должен убивать сессию — деградируем до failed-результата.
        if (err instanceof Error && err.name === "AbortError") {
          synthesizePendingToolResults();
          throw err;
        }
        logger.diagnostic("warn", `Tool ${call.name} threw: ${errMsg(err)}`);
        // INV-15: «попытка тула сорвалась» — отдельный сигнал, чтобы исключение
        // хендлера, проглоченное в failed-результат, было отличимо от обычного
        // `tool_result success:false` (у того причина — контент, не баг).
        slog?.logDiagnosticEvent("tool_attempt", {
          source: `tool:${call.name}`,
          operation: "tool.execute",
          kind: "failed",
          cause: errMsg(err),
        });
        result = {
          success: false,
          output: `${t("error.prefix")}${errMsg(err)}`,
          toolCallId: call.id,
        };
      }
      return {
        result,
        duration: Date.now() - startTime,
        tokensBeforeTool,
        costBeforeTool,
        shutdown: this.deps.isShutdownRequested(),
      };
    };

    /** После выполнения: плагины/UI/контекст/учёт. Всегда serial, в порядке вызовов. */
    const finalizeCall = (
      call: ToolCall,
      result: ToolResult,
      duration: number,
      tokensBeforeTool: number,
      costBeforeTool: number | undefined,
    ): void => {
      // Plugin-level блок считается неудачей для honest-stop: перебор
      // заблокированных вариантов — та же петля, а «нейтральность» замораживала
      // счётчик навсегда (§1.7 аудита). Успехом блок при этом не становится.
      if (!result.success && !INFO_TOOLS.has(call.name)) anyToolFailed = true;
      if (result.success) batchHasSuccess = true;

      trackToolResultSideEffects(this.deps, state, call, result);
      pluginManager.runOnToolEnd(
        { iteration, logger, contextManager },
        { id: call.id, name: call.name, arguments: call.arguments },
        result,
        duration,
      );
      renderToolResultMeta(this.deps, iteration, result, onMeta);

      const truncatedOutput = truncateToolOutput(
        result.output,
        contextManager.getBudget(),
        contextManager.getEstimatedTokens(),
        boundedToolNames.has(call.name),
      );
      contextManager.addMessage({
        role: "tool",
        content: appendErrorMeta(truncatedOutput, result.errorMeta),
        name: call.name,
        tool_call_id: call.id,
        success: result.success,
        blocked: result.blocked,
        arguments: call.arguments,
      });
      answeredToolCallIds.add(call.id);

      // Изображения тула (browser screenshot и т.п.) встают в очередь и
      // прицепятся к следующему user-сообщению — обычно к <system-summary>
      // в конце этого же batch'а. В role:"tool" строку base64 не пишем.
      queueToolImages(contextManager, result.images);

      // Персист полноразмерных ассетов для web-ленты/истории: refs уходят в
      // событие (live) и в session.jsonl (replay). Шифрованная сессия → refs
      // пусты, forwarder позаботится о inline-фолбэке.
      persistResultImages(slog, result, config);

      const tokensAfterTool = contextManager.getEstimatedTokens();
      const costAfterTool = this.deps.costTracker.total;
      onTool?.({
        type: "end",
        tool: call.name,
        args: call.arguments,
        callId: call.id,
        duration,
        error: !result.success,
        output: typeof result.output === "string" ? result.output : undefined,
        ...imageEventFields(result),
        ctxDelta: tokensAfterTool - tokensBeforeTool,
        costUsd:
          costBeforeTool !== undefined && costAfterTool !== undefined
            ? costAfterTool - costBeforeTool
            : undefined,
      });

      summaries.push(
        `[Tool: ${call.name}${summarizeToolArgs(call.arguments)} → ${truncatedOutput.slice(0, 200)}]`,
      );

      // Скрипт-обход: после блока безопасности запись shell-скрипта-обёртки —
      // nudge один раз, обобщённо (без привязки к тулу/языку).
      if (detectScriptWorkaround(state, call, result)) {
        summaries.push(t("exec.script_workaround_nudge"));
      }

      if (config.session.autoSave) {
        slog?.logToolResult(call, result, duration, iteration, result.imageRefs);
      }
      this.deps.compactionService.compactAfterTool(state);
      recordRepeatedToolFailure(state, call, result, {
        memoryStore: this.deps.memoryStore,
        contextManager: this.deps.contextManager,
        logger,
      });
    };

    // ── Планировщик: подряд идущие parallelizable-вызовы (≥2) идут конкурентно. ──

    const isParallelizable = (call: ToolCall): boolean =>
      this.deps.toolExecutor.getRegistry().get(call.name)?.parallelizable === true;
    const maxParallel =
      this.deps.config.security?.rateLimits?.maxParallelTasks ?? DEFAULT_MAX_PARALLEL_TOOLS;

    let index = 0;
    while (index < toolCalls.length) {
      const first = toolCalls[index];
      if (isParallelizable(first)) {
        let end = index;
        while (end < toolCalls.length && isParallelizable(toolCalls[end])) end++;
        const group = toolCalls.slice(index, end);
        if (group.length >= 2) {
          // 1. Подготовка serial, в порядке — hook-и не гоняются конкурентно.
          for (const call of group) prepareCall(call);
          // 2. Конкурентное выполнение: свой fork на вызов (изоляция scope/
          //    recursionDepth/cleanup), общий кап из rateLimits.
          const execs = await runWithConcurrency(group, maxParallel, (call) =>
            executeCall(call, this.deps.toolExecutor.fork()),
          );
          // 3. Прерывание посреди волны: работу не рендерим, добиваем
          //    unanswered-результаты и выходим (как serial shutdown-путь).
          if (this.deps.isShutdownRequested()) {
            synthesizePendingToolResults();
            return { interrupted: true };
          }
          // 4. Финализация serial, в порядке — детерминированный порядок
          //    role:"tool" сообщений и UI-событий.
          for (let k = 0; k < group.length; k++) {
            const e = execs[k];
            finalizeCall(group[k], e.result, e.duration, e.tokensBeforeTool, e.costBeforeTool);
          }
          index = end;
          continue;
        }
      }
      prepareCall(first);
      const exec = await executeCall(first, this.deps.toolExecutor);
      // Прерывание во время тула: сессия уже завершается, останавливаемся
      // сразу — без рендера, логов и обновления контекста для результата,
      // который никто не увидит.
      if (exec.shutdown) break;
      finalizeCall(first, exec.result, exec.duration, exec.tokensBeforeTool, exec.costBeforeTool);
      index++;
    }

    if (this.deps.isShutdownRequested()) {
      synthesizePendingToolResults();
      return { interrupted: true };
    }

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
      // Директива и правило в память — не на каждый батч: инжект на каждом
      // пакете с фейлом давал до ~190 дублей директив и правил за ход, и каждая
      // запись мутировала блок памяти ⇒ рвался prompt-cache (§1.6 аудита).
      const directiveDue =
        state.iteration - state.lastRecoveryDirectiveIteration >= RECOVERY_DIRECTIVE_REFRESH;
      if (directiveDue) {
        state.lastRecoveryDirectiveIteration = state.iteration;
        const recoveryMsg = t("exec.consecutive_failures_recovery", {
          count: state.consecutiveToolFailures,
        });
        const taskSnippet = input.length > 200 ? `${input.slice(0, 200)}...` : input;
        const taskReminder = t("exec.task_reminder", { task: taskSnippet });
        issueDirective(
          contextManager,
          "consecutive_failures",
          `${recoveryMsg}\n${taskReminder}`,
        );
      }

      const memStore = this.deps.memoryStore;
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
      logger.diagnostic("warn", `Retry loop terminated after ${state.consecutiveFailedBatches} consecutive failed batches — forcing final answer`);
      return { interrupted: false, finalize: "failed_batches" };
    }

    // Duplicate-бюджет: серия пакетов, где КАЖДЫЙ вызов дословно повторяет уже
    // сделанный за ход (канонический ключ). Широкая разведка новыми файлами и
    // паттернами прогрессирует — стрик не набирает. Опрос процесса
    // (process_log/process_wait) — легитимный повтор, стрик не питает.
    const isPurePoll = toolCalls.length > 0 && toolCalls.every((c) => POLL_TOOLS.has(c.name));
    const keys = toolCalls.map((c) => canonicalArgsKey(c.name, c.arguments));
    const isDuplicateBatch =
      !isPurePoll &&
      toolCalls.length > 0 &&
      keys.every((k) => state.seenToolCalls.has(k));
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
      return { interrupted: false, finalize: "duplicate" };
    }

    // Веб-разведка без результата: серия пакетов, целиком из внешних веб-тулов.
    // Только директива (без жёсткого стопа) — «сведи поиск к результату».
    const isResearchBatch =
      toolCalls.length > 0 && toolCalls.every((c) => RESEARCH_TOOLS.has(c.name));
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
    // consecutiveFailedBatches (сбрасывается успехом), ни
    // consecutiveToolFailures. В ses_mvpdchvi это дало 29 отказов из 98 пакетов
    // без единой эскалации — единственной реакцией было отключение bash.
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
      return { interrupted: false, finalize: "stalled" };
    }

    // Нарратив: серия пакетов без единого слова пользователю. Модель, ушедшая
    // в молчаливые вызовы, для пользователя неотличима от зависшего процесса:
    // в ses_mvpdchvi 98 шагов подряд прошли без текста, ход дважды прерван.
    const said = textContent.trim().length >= MIN_NARRATION_CHARS;
    if (said) {
      state.consecutiveSilentBatches = 0;
      state.narrationNudged = false;
      clearDirective(contextManager, "narration");
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
      return { interrupted: false, finalize: "silent" };
    }

    // Статусная строка плана после каждого пакета тулов. Заменяет динамический
    // plan-блок, который жил в system prompt (удалён ради KV-cache — план
    // меняется каждую итерацию).
    const planLine = this.deps.planSummary?.();
    if (planLine) summaries.push(planLine);

    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${summaries.join("\n")}</system-summary>`,
    });

    return { interrupted: false };
  }
}

