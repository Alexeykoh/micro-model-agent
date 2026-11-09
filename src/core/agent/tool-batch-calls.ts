/**
 * Жизненный цикл одного вызова тула внутри пакета: подготовка, исполнение,
 * финализация.
 *
 * Вынесено из `tool-batch.ts` (правило 6): serial- и parallel-путь делят один
 * и тот же код вызова. Оркестрация (планировщик, recovery-сигналы) остаётся в
 * `tool-batch.ts`; здесь — только вызов и его побочные эффекты.
 */
import { t } from "../../i18n/index";
import { visibleFileContent } from "../../modules/security/data-policy/file-content";
import type { ToolExecutor } from "../../tools/executor";
import type { ToolResult } from "../../tools/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import type { OnMeta, ToolCall, ToolEvent } from "../types";
import type { ToolBatchDeps } from "./tool-batch";
import { errMsg } from "../../utils";
import { appendErrorMeta, summarizeToolArgs, truncateToolOutput } from "./tool-output";
import { queueToolImages } from "./tool-images";
import { imageEventFields, renderToolResultMeta } from "./tool-result-meta";
import { recordRepeatedToolFailure } from "./failure-memory";
import {
  bumpBudgetAfterWriteTooLarge,
  detectScriptWorkaround,
  emitSynthesizedToolResults,
  persistResultImages,
  trackToolResultSideEffects,
} from "./tool-batch-effects";

/** Информационные read-only тулы, чей "фейл" — ожидаемое поведение. */
const INFO_TOOLS = new Set(["file_info"]);

/** Параметры одного пакета, общие для всех вызовов. */
export interface ToolCallRunnerInit {
  deps: ToolBatchDeps;
  state: LoopState;
  iteration: number;
  toolCalls: ToolCall[];
  boundedToolNames: Set<string>;
  slog?: SessionLogger;
  onTool?: (ev: ToolEvent) => void;
  onMeta?: OnMeta;
  answeredToolCallIds: Set<string>;
  summaries: string[];
  digestMode: "full" | "failures" | "off";
}

/** Итог исполнения одного вызова: результат и снимки для рендера. */
export interface ToolCallExecution {
  result: ToolResult;
  duration: number;
  tokensBeforeTool: number;
  costBeforeTool: number | undefined;
  shutdown: boolean;
}

/**
 * Исполнитель вызовов одного пакета. Держит batch-scoped счётчики
 * (`anyToolFailed`/`batchHasSuccess`), которые читает оркестратор после
 * цикла, и общий набор `answeredToolCallIds` для синтеза заглушек.
 */
export class ToolCallRunner {
  private anyToolFailed = false;
  private batchHasSuccess = false;

  constructor(private readonly init: ToolCallRunnerInit) {}

  /** Был ли в пакете хоть один фейл (кроме информационных тулов). */
  get hadFailure(): boolean {
    return this.anyToolFailed;
  }

  /** Был ли в пакете хоть один успех. */
  get hadSuccess(): boolean {
    return this.batchHasSuccess;
  }

  /** Досылает `role:"tool"`-заглушки для вызовов без результата. */
  synthesizePending(): void {
    emitSynthesizedToolResults(
      this.init.deps.contextManager,
      this.init.toolCalls,
      this.init.answeredToolCallIds,
      this.init.deps.logger,
    );
  }

  /** До выполнения: сброс scope, hook-и вызова, UI-старт, запись вызова. */
  prepare(call: ToolCall): void {
    const { pluginManager, toolExecutor, contextManager, logger } = this.init.deps;
    const { iteration, slog, onTool } = this.init;
    this.init.deps.setScope();
    pluginManager.runOnToolCall({
      toolName: call.name,
      args: call.arguments,
    });
    pluginManager.runOnToolStart(
      { iteration, logger, contextManager },
      { id: call.id, name: call.name, arguments: call.arguments },
    );
    const toolIcon = toolExecutor.getRegistry().get(call.name)?.icon;
    onTool?.({ type: "start", tool: call.name, args: call.arguments, callId: call.id, icon: toolIcon });
    slog?.logToolCall(call, iteration);
  }

  /**
   * Выполнение хендлера (allowlist/плагины/таймаут — внутри executor'а).
   * `shutdown: true` — итерация прервана (Esc/Ctrl+C): вызывающий выходит,
   * не рендеря результат.
   */
  async execute(call: ToolCall, executor: ToolExecutor): Promise<ToolCallExecution> {
    const { contextManager, logger, costTracker, getAbortSignal, isShutdownRequested } = this.init.deps;
    const { slog } = this.init;
    const startTime = Date.now();
    const tokensBeforeTool = contextManager.getEstimatedTokens();
    // Снимок стоимости ДО тула: рендеру нужна стоимость именно этого вызова
    // (subagent/mcp/pipeline тратят токены), а не накопленная за сессию.
    const costBeforeTool = costTracker.total;
    let result: ToolResult;
    try {
      result = await executor.execute(call, getAbortSignal());
    } catch (err) {
      // Abort во время тула должен распространяться, чтобы сессия завершилась
      // чисто. Любой ДРУГОЙ throw (баг тула/плагина, сбежавший из executor)
      // не должен убивать сессию — деградируем до failed-результата.
      if (err instanceof Error && err.name === "AbortError") {
        this.synthesizePending();
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
      shutdown: isShutdownRequested(),
    };
  }

  /** После выполнения: плагины/UI/контекст/учёт. Всегда serial, в порядке вызовов. */
  finalize(call: ToolCall, exec: ToolCallExecution): void {
    const { deps } = this.init;
    const { config, pluginManager, contextManager, logger } = deps;
    const { iteration, slog, onTool, onMeta, boundedToolNames, summaries, digestMode } = this.init;
    const { result, duration, tokensBeforeTool, costBeforeTool } = exec;

    // Plugin-level блок считается неудачей для honest-stop: перебор
    // заблокированных вариантов — та же петля, а «нейтральность» замораживала
    // счётчик навсегда (§1.7 аудита). Успехом блок при этом не становится.
    if (!result.success && !INFO_TOOLS.has(call.name)) this.anyToolFailed = true;
    if (result.success) this.batchHasSuccess = true;

    trackToolResultSideEffects(deps, this.init.state, call, result);
    bumpBudgetAfterWriteTooLarge(this.init.state, call, result);
    pluginManager.runOnToolEnd(
      { iteration, logger, contextManager },
      { id: call.id, name: call.name, arguments: call.arguments },
      result,
      duration,
    );
    renderToolResultMeta(deps, iteration, result, onMeta);

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
    this.init.answeredToolCallIds.add(call.id);

    // Изображения тула (browser screenshot и т.п.) встают в очередь и
    // прицепятся к следующему user-сообщению — обычно к <system-summary>
    // в конце этого же batch'а. В role:"tool" строку base64 не пишем.
    queueToolImages(contextManager, result.images);

    // Персист полноразмерных ассетов для web-ленты/истории: refs уходят в
    // событие (live) и в session.jsonl (replay). Шифрованная сессия → refs
    // пусты, forwarder позаботится о inline-фолбэке.
    persistResultImages(slog, result, config);

    const tokensAfterTool = contextManager.getEstimatedTokens();
    const costAfterTool = deps.costTracker.total;
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

    // Дублировать вывод в <system-summary>? Сам результат уже ушёл
    // `role:"tool"`; копия стоит ~13% prompt-токенов (spec
    // 2026-10-26-tool-digest-channel-design).
    if (digestMode === "full" || (digestMode === "failures" && !result.success)) {
      summaries.push(
        `[Tool: ${call.name}${summarizeToolArgs(call.arguments)} → ${visibleFileContent(truncatedOutput, 200)}]`,
      );
    }

    // Скрипт-обход: после блока безопасности запись shell-скрипта-обёртки —
    // nudge один раз, обобщённо (без привязки к тулу/языку).
    if (detectScriptWorkaround(this.init.state, call, result)) {
      summaries.push(t("exec.script_workaround_nudge"));
    }

    if (config.session.autoSave) {
      slog?.logToolResult(call, result, duration, iteration, result.imageRefs);
    }
    deps.compactionService.compactAfterTool(this.init.state);
    recordRepeatedToolFailure(this.init.state, call, result, {
      memoryStore: deps.memoryStore,
      contextManager: deps.contextManager,
      logger,
    });
  }
}
