import { pc } from "../../ui/colors";
import { t } from "../../i18n/index";
import type { AppConfig } from "../../config/types";
import type { ContextManager } from "../../modules/context/manager";
import type { HallucinationDetector } from "../../modules/hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { MemoryStore } from "../../modules/memory/store";
import type { PluginManager } from "../../modules/plugins/manager";
import type { CostTracker } from "../../modules/pricing/index";
import type { ToolExecutor } from "../../tools/executor";
import type { SessionLogger } from "../session-logger";
import type { ToolCall, ToolEvent } from "../types";
import type { LoopState } from "./loop-state";
import { summarizeToolArgs, truncateToolOutput } from "./tool-output";
import type { CompactionService } from "./compaction";
import {
  MAX_CONSECUTIVE_TOOL_FAILURES,
  MIN_REPEATED_TOOL_FAILURES,
} from "./constants";

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

export interface ToolBatchExecution {
  /** Истинно, если итерация прервана по shutdown — цикл должен выйти. */
  interrupted: boolean;
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
export class ToolBatchExecutor {
  constructor(private readonly deps: ToolBatchDeps) {}

  async execute(
    state: LoopState,
    toolCalls: ToolCall[],
    boundedToolNames: Set<string>,
    textContent: string,
    reasoningContent: string,
    input: string,
    onTool?: (ev: ToolEvent) => void,
    onMeta?: (meta: string) => void,
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
    const synthesizePendingToolResults = (): void => {
      for (const call of toolCalls) {
        if (answeredToolCallIds.has(call.id)) continue;
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
    };

    const summaries: string[] = [];
    let anyToolFailed = false;
    // Информационные read-only тулы, чей "фейл" — ожидаемое поведение
    // (file_info "Not found" после delete_file) — исключены из учёта неудач.
    const infoTools = new Set(["file_info"]);

    for (const call of toolCalls) {
      this.deps.setScope();
      const startTime = Date.now();
      pluginManager.runOnToolCall({
        toolName: call.name,
        args: call.arguments,
      });
      pluginManager.runOnToolStart(
        { iteration, logger, contextManager },
        { id: call.id, name: call.name, arguments: call.arguments },
      );
      const toolIcon = this.deps.toolExecutor.getRegistry().get(call.name)?.icon;
      onTool?.({ type: "start", tool: call.name, args: call.arguments, icon: toolIcon });
      slog?.logToolCall(call, iteration);

      const tokensBeforeTool = contextManager.getEstimatedTokens();
      let result;
      try {
        result = await this.deps.toolExecutor.execute(call, this.deps.getAbortSignal());
      } catch (err) {
        // Abort во время тула должен распространяться, чтобы сессия завершилась
        // чисто. Любой ДРУГОЙ throw (баг тула/плагина, сбежавший из executor)
        // не должен убивать сессию — деградируем до failed-результата.
        if (err instanceof Error && err.name === "AbortError") {
          synthesizePendingToolResults();
          throw err;
        }
        logger.warn(`Tool ${call.name} threw: ${err instanceof Error ? err.message : String(err)}`);
        result = {
          success: false,
          output: `${t("error.prefix")}${err instanceof Error ? err.message : String(err)}`,
          toolCallId: call.id,
        };
      }
      // Прерывание во время тула: сессия уже завершается, останавливаемся
      // сразу — без рендера, логов и обновления контекста для результата,
      // который никто не увидит.
      if (this.deps.isShutdownRequested()) break;
      const duration = Date.now() - startTime;
      if (!result.success && !infoTools.has(call.name)) anyToolFailed = true;

      if (result.success && call.name === "plan") {
        const action = String(call.arguments.action ?? "");
        if (action === "create" || action === "re-plan") state.iterPlanCreated = true;
      }
      if (result.success && call.arguments.path) {
        const filePath = String(call.arguments.path);
        if (call.name === "write_file" || call.name === "edit_file") {
          this.deps.hallucinationDetector.getConsistencyCheck().trackCreatedFile(filePath);
        } else if (call.name === "delete_file") {
          this.deps.hallucinationDetector.getConsistencyCheck().trackDeletedFile(filePath);
        }
      }

      pluginManager.runOnToolEnd(
        { iteration, logger, contextManager },
        { id: call.id, name: call.name, arguments: call.arguments },
        result,
        duration,
      );
      // Проверка наличия, а не истинности: read_file возвращает display ""
      // на полном чтении (заголовок уже показывает путь) — фолбэк на пустую
      // строку вывалил бы всё содержимое файла в REPL.
      if (result.display !== undefined) {
        if (result.display.length > 0) {
          onMeta?.("\n" + result.display + "\n");
        }
      } else {
        const metaOut = pluginManager.runOnMeta(
          { iteration, logger, contextManager },
          result.output,
        );
        onMeta?.("\n" + pc.dim(metaOut) + "\n");
      }
      if (result.diff) {
        onMeta?.("\n" + result.diff + "\n");
      }

      const currentTokens = contextManager.getEstimatedTokens();
      const budget = contextManager.getBudget();
      const truncatedOutput = truncateToolOutput(
        result.output,
        budget,
        currentTokens,
        boundedToolNames.has(call.name),
      );
      contextManager.addMessage({
        role: "tool",
        content: truncatedOutput,
        name: call.name,
        tool_call_id: call.id,
        success: result.success,
        arguments: call.arguments,
      });
      answeredToolCallIds.add(call.id);

      const tokensAfterTool = contextManager.getEstimatedTokens();
      onTool?.({
        type: "end",
        tool: call.name,
        args: call.arguments,
        duration,
        error: !result.success,
        ctxDelta: tokensAfterTool - tokensBeforeTool,
        costUsd: this.deps.costTracker.total,
      });

      summaries.push(
        `[Tool: ${call.name}${summarizeToolArgs(call.arguments)} → ${truncatedOutput.slice(0, 200)}]`,
      );

      if (config.session.autoSave) {
        slog?.logToolResult(call, result, duration, iteration);
      }
      this.deps.compactionService.compactAfterTool(state);

      // Учёт общих неудач (НЕ только подряд идущих): тул, который стабильно
      // падает между успехами других тулов, всё равно учится (наблюдалось:
      // LSP spawn npx ENOENT упал 8x за сессию, ни разу подряд — и не дошёл
      // до памяти по пути "5 подряд неудач").
      if (!result.success && !infoTools.has(call.name)) {
        const key = call.name;
        const prev = state.toolFailureCounts.get(key) ?? { count: 0, error: "" };
        prev.count++;
        prev.error = String(result.output ?? "").slice(0, 200);
        state.toolFailureCounts.set(key, prev);
        if (prev.count >= MIN_REPEATED_TOOL_FAILURES && !state.memoryRuleRecorded.has(key)) {
          state.memoryRuleRecorded.add(key);
          const memStore = this.deps.memoryStore;
          if (memStore) {
            memStore.appendRule(
              "errors",
              `Tool ${key} failed ${prev.count}x (${prev.error})`,
              `Repeated ${key} failures suggest a systemic problem (config, environment, or a broken tool), not a one-off`,
              "Check the error message, verify the tool's dependencies are installed/configured, and consider a different tool",
            );
            logger.warn(`Recorded repeated ${key} failures to memory (${prev.count}x)`);
          }
        }
      }
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
    }
    if (state.consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      const recoveryMsg = t("exec.consecutive_failures_recovery", {
        count: state.consecutiveToolFailures,
      });
      logger.warn(`Consecutive tool failures: ${state.consecutiveToolFailures}`);
      const taskSnippet = input.length > 200 ? input.slice(0, 200) + "..." : input;
      const taskReminder = t("exec.task_reminder", { task: taskSnippet });
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${recoveryMsg}\n${taskReminder}</system-summary>`,
      });

      const memStore = this.deps.memoryStore;
      if (memStore) {
        memStore.appendRule(
          "errors",
          `${state.consecutiveToolFailures} consecutive tool failures`,
          "Multiple tools failing suggests environment or configuration issue",
          "Check dependencies, verify file paths, try write_file directly instead of shell commands",
        );
      }
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