/** Исполнитель пакета тулов: жизненный цикл вызовов за итерацию. */
import type { AppConfig } from "../../config/types";
import type { ContextManager } from "../../core/context/manager";
import type { HallucinationDetector } from "../../core/hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { MemoryStore } from "../../modules/memory/store";
import type { PluginManager } from "../../modules/plugins/manager";
import type { CostTracker } from "../../modules/pricing/index";
import type { ToolExecutor } from "../../tools/executor";
import type { SessionLogger } from "../session-logger";
import type { OnMeta, StopReason, ToolCall, ToolEvent } from "../types";
import type { LoopState } from "./loop-state";
import type { CompactionService } from "./compaction";
import { ToolCallRunner } from "./tool-batch-calls";
import { applyBatchSignals } from "./tool-batch-signals";

/** Дефолтный кап конкурентных тулов одного batch'а (см. security.rateLimits). */
const DEFAULT_MAX_PARALLEL_TOOLS = 5;

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
 * `break`/`continue` принимает вызывающий цикл. Один вызов живёт в
 * `ToolCallRunner`, recovery-сигналы — в `applyBatchSignals` (правило 6).
 */

export {
  diagnoseRepeatedFailures,
  type RepeatedFailureDiagnosis,
} from "./failure-diagnosis";

export class ToolBatchExecutor {
  constructor(private readonly deps: ToolBatchDeps) {}

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
    const { config, contextManager } = this.deps;
    const iteration = state.iteration;

    slog?.logAssistant(
      textContent || "",
      reasoningContent,
      toolCalls,
      iteration,
      state.lastFinishReason,
    );

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

    // OpenAI-совместимые бэкенды (Jinja-шаблоны llama.cpp) отклоняют HTTP 400
    // любую историю, где assistant(tool_calls) не завершён role:"tool"
    // результатами для каждого call id — прерывание на середине пакета не
    // должно оставлять висящую пару.
    const summaries: string[] = [];
    const runner = new ToolCallRunner({
      deps: this.deps,
      state,
      iteration,
      toolCalls,
      boundedToolNames,
      slog,
      onTool,
      onMeta,
      answeredToolCallIds: new Set<string>(),
      summaries,
      digestMode: config.contextBudget?.toolDigest ?? "full",
    });

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
          for (const call of group) runner.prepare(call);
          // 2. Конкурентное выполнение: свой fork на вызов (изоляция scope/
          //    recursionDepth/cleanup), общий кап из rateLimits.
          const execs = await runWithConcurrency(group, maxParallel, (call) =>
            runner.execute(call, this.deps.toolExecutor.fork()),
          );
          // 3. Прерывание посреди волны: работу не рендерим, добиваем
          //    unanswered-результаты и выходим (как serial shutdown-путь).
          if (this.deps.isShutdownRequested()) {
            runner.synthesizePending();
            return { interrupted: true };
          }
          // 4. Финализация serial, в порядке — детерминированный порядок
          //    role:"tool" сообщений и UI-событий.
          for (let k = 0; k < group.length; k++) {
            await runner.finalize(group[k], execs[k]);
          }
          index = end;
          continue;
        }
      }
      runner.prepare(first);
      const exec = await runner.execute(first, this.deps.toolExecutor);
      // Прерывание во время тула: сессия уже завершается, останавливаемся
      // сразу — без рендера, логов и обновления контекста для результата,
      // который никто не увидит.
      if (exec.shutdown) break;
      await runner.finalize(first, exec);
      index++;
    }

    if (this.deps.isShutdownRequested()) {
      runner.synthesizePending();
      return { interrupted: true };
    }

    // Recovery-сигналы: неудачи, повторы, разведка, окно фейлов, молчание.
    const signals = applyBatchSignals({
      state,
      contextManager,
      logger: this.deps.logger,
      slog,
      input,
      textContent,
      toolCalls,
      anyToolFailed: runner.hadFailure,
      batchHasSuccess: runner.hadSuccess,
      memoryStore: this.deps.memoryStore,
    });
    if (signals.finalize) return { interrupted: false, finalize: signals.finalize };

    // Статусная строка плана после каждого пакета тулов. Заменяет динамический
    // plan-блок, который жил в system prompt (удалён ради KV-cache — план
    // меняется каждую итерацию).
    const planLine = this.deps.planSummary?.();
    if (planLine) summaries.push(planLine);

    // Пустая сводка — шум: сообщения без содержания модель не читает.
    if (summaries.length > 0) {
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${summaries.join("\n")}</system-summary>`,
      });
    }

    return { interrupted: false };
  }
}
