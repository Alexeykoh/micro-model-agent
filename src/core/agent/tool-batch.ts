/** Исполнитель пакета тулов: жизненный цикл вызовов за итерацию. */
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
import type { MetaKind, OnMeta } from "../types";
import type { ToolResult } from "../../tools/types";
import type { LoopState } from "./loop-state";
import {
  summarizeToolArgs,
  truncateToolOutput,
  toolFailureSummary,
  isExecutableScriptPath,
  appendErrorMeta,
} from "./tool-output";
import { queueToolImages } from "./tool-images";
import { errMsg } from "../../utils";
import type { CompactionService } from "./compaction";
import { MAX_CONSECUTIVE_TOOL_FAILURES, MIN_REPEATED_TOOL_FAILURES, MAX_CONSECUTIVE_FAILED_BATCHES, HARD_STOP_FAILED_BATCHES, MAX_READONLY_BATCHES, HARD_STOP_READONLY_BATCHES } from "./constants";

/**
 * Тулы, не производящие побочных эффектов (чтение/поиск/fetch/статус). Пакет
 * только из них считается «read-only исследованием»: серия таких пакетов без
 * единой мутации питает read-only бюджет (см. `MAX_READONLY_BATCHES`).
 * Намеренно НЕ включены: process_wait (ожидание), plan/enable_tools/set_thinking
 * (мена состояния), question/approve (интерактив), subagent (может мутировать).
 */
const READONLY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "file_info",
  "project_map",
  "web_search",
  "web_fetch",
  "web_browse",
  "chunk_query",
  "recall",
  "search_history",
  "session_info",
  "process_list",
  "process_log",
]);

/** Транзиентные сетевые тулы: их фейлы не пишем в глобальную память (не системная поломка). */
const TRANSIENT_TOOLS = new Set(["web_fetch", "web_search", "web_browse"]);

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

/** Диагноз повторных падений тула для записи в память. */
export interface RepeatedFailureDiagnosis {
  /** true — промах модели, а не системы: в глобальную память не писать. */
  skip: boolean;
  cause: string;
  solution: string;
}

/**
 * Диагноз по сигнатуре ошибок (ses_mup6p61q): раньше в память шёл boilerplate
 * («проверьте зависимости») и туда же попадали собственные промахи модели
 * (несуществующий путь теста как «системная проблема bash»).
 * - bash с «не найдено/не сматчилось» по именованной моделью цели → skip;
 * - edit_file «строка не найдена» → гипотеза расхождения якоря (CRLF/устаревшее
 *   чтение), а не сломанный тул;
 * - остальное → запись с наблюдаемыми заголовками ошибок.
 */
export function diagnoseRepeatedFailures(
  tool: string,
  headlines: string[],
): RepeatedFailureDiagnosis {
  const genericCause =
    "Repeated failures suggest a systemic problem (config, environment, or a broken tool), not a one-off";
  const genericSolution =
    "Check the error message, verify the tool's dependencies are installed/configured, and consider a different tool";

  const modelMiss =
    tool === "bash"
      ? [/did not match any test files?/i, /no such file/i, /cannot find (the )?path/i]
      : [];
  if (
    headlines.length > 0 &&
    headlines.every(
      (h) => /^\(exit code \d+\)$/.test(h.trim()) || modelMiss.some((re) => re.test(h)),
    )
  ) {
    return {
      skip: true,
      cause: "Model named a wrong target (path/filter); the tool itself works",
      solution: "Re-check the target path or filter instead of blaming the tool",
    };
  }

  if (tool === "edit_file" && headlines.some((h) => /string not found|не найдена/i.test(h))) {
    return {
      skip: false,
      cause:
        "Anchor mismatch between the model anchor and file content — often CRLF vs LF line endings or a stale read, not a broken tool",
      solution:
        "Re-read the exact block with read_file and retry with a short unique single-line anchor",
    };
  }

  return { skip: false, cause: genericCause, solution: genericSolution };
}

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
    let batchHasSuccess = false;
    // Информационные read-only тулы, чей "фейл" — ожидаемое поведение
    // (file_info "Not found" после delete_file) — исключены из учёта неудач.
    const infoTools = new Set(["file_info"]);
    // Флаг блока безопасности действует в пределах текущего пакета вызовов:
    // иначе старый блок влиял бы на nudge через десятки итераций.
    state.sawSecurityBlock = false;

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
      // Снимок стоимости ДО тула: рендеру нужна стоимость именно этого вызова
      // (subagent/mcp/pipeline тратят токены), а не накопленная за сессию.
      const costBeforeTool = this.deps.costTracker.total;
      let result: ToolResult;
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
        logger.diagnostic("warn", `Tool ${call.name} threw: ${errMsg(err)}`);
        result = {
          success: false,
          output: `${t("error.prefix")}${errMsg(err)}`,
          toolCallId: call.id,
        };
      }
      // Прерывание во время тула: сессия уже завершается, останавливаемся
      // сразу — без рендера, логов и обновления контекста для результата,
      // который никто не увидит.
      if (this.deps.isShutdownRequested()) break;
      const duration = Date.now() - startTime;
      if (!result.success && !result.blocked && !infoTools.has(call.name)) anyToolFailed = true;
      if (result.success) batchHasSuccess = true;

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
      // kind="tool": тела тулов model-facing, в quiet-чатах скрываются
      // (статусы контекста/компакции идут с kind по умолчанию и всегда видны).
      const TOOL_META: MetaKind = "tool";
      if (result.display !== undefined) {
        if (result.display.length > 0) {
          onMeta?.(`\n${result.display}\n`, TOOL_META);
        }
      } else if (result.success) {
        const metaOut = pluginManager.runOnMeta(
          { iteration, logger, contextManager },
          result.output,
        );
        onMeta?.(`\n${pc.dim(metaOut)}\n`, TOOL_META);
      } else {
        // Упавший тул: `output` — model-facing (хинты, recovery-директивы,
        // «Do NOT …»). Пользователю нужна спокойная суть — первая строка,
        // а не инструкции для агента. Мягкие гарды — варнинги, не ошибки.
        const failure = toolFailureSummary(result.output);
        const metaOut = failure.text
          ? pluginManager.runOnMeta({ iteration, logger, contextManager }, failure.text)
          : "";
        if (metaOut) {
          const color = failure.severity === "warn" ? pc.yellow : pc.red;
          const glyph = failure.severity === "warn" ? "⚠" : "✗";
          onMeta?.(`\n${color(`${glyph} ${metaOut}`)}\n`, TOOL_META);
        }
      }
      if (result.diff) {
        onMeta?.(`\n${result.diff}\n`, TOOL_META);
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

      const tokensAfterTool = contextManager.getEstimatedTokens();
      const costAfterTool = this.deps.costTracker.total;
      onTool?.({
        type: "end",
        tool: call.name,
        args: call.arguments,
        duration,
        error: !result.success,
        output: typeof result.output === "string" ? result.output : undefined,
        ctxDelta: tokensAfterTool - tokensBeforeTool,
        costUsd:
          costBeforeTool !== undefined && costAfterTool !== undefined
            ? costAfterTool - costBeforeTool
            : undefined,
      });

      summaries.push(
        `[Tool: ${call.name}${summarizeToolArgs(call.arguments)} → ${truncatedOutput.slice(0, 200)}]`,
      );

      // Видели блок безопасности? Запоминаем для эвристики скрипта-обёртки.
      if (typeof result.output === "string" && result.output.includes("[SECURITY BLOCKED]")) {
        state.sawSecurityBlock = true;
      }
      // Скрипт-обход: после блока безопасности запись shell-скрипта
      // (.bat/.cmd/.sh/.ps1) почти всегда — попытка обойти заблокированный
      // оператор; nudge один раз, обобщённо (без привязки к тулу/языку).
      if (
        state.sawSecurityBlock &&
        !state.scriptWorkaroundNudged &&
        call.name === "write_file" &&
        typeof call.arguments.path === "string" &&
        isExecutableScriptPath(call.arguments.path)
      ) {
        state.scriptWorkaroundNudged = true;
        summaries.push(t("exec.script_workaround_nudge"));
      }

      if (config.session.autoSave) {
        slog?.logToolResult(call, result, duration, iteration);
      }
      this.deps.compactionService.compactAfterTool(state);

    // Учёт общих неудач (НЕ только подряд идущих): тул, который стабильно
    // падает между успехами других тулов, всё равно учится (наблюдалось:
    // LSP spawn npx ENOENT упал 8x за сессию, ни разу подряд — и не дошёл
    // до памяти по пути "5 подряд неудач"). Транзиентные сетевые тулы
    // (web_fetch/web_search) исключены: смена сайта/лимит — не системная
    // поломка, а запись в память засоряла errors.md мусором (404/TLS/сертификат).
    if (!result.success && !result.blocked && !infoTools.has(call.name) && !TRANSIENT_TOOLS.has(call.name)) {
        const key = call.name;
        const prev = state.toolFailureCounts.get(key) ?? { count: 0, error: "", samples: [] };
        prev.count++;
        const errText = String(result.output ?? "");
        prev.error = errText.slice(0, 200);
        const headline = errText.split("\n")[0].slice(0, 160).trim();
        if (headline && !prev.samples.includes(headline) && prev.samples.length < 3) {
          prev.samples.push(headline);
        }
        state.toolFailureCounts.set(key, prev);
        if (prev.count >= MIN_REPEATED_TOOL_FAILURES && !state.memoryRuleRecorded.has(key)) {
          state.memoryRuleRecorded.add(key);
          const memStore = this.deps.memoryStore;
          const diagnosis = diagnoseRepeatedFailures(key, prev.samples);
          if (memStore && !diagnosis.skip) {
            memStore.appendRule(
              "errors",
              `Tool ${key} failed ${prev.count}x (${prev.samples.join(" | ") || prev.error})`,
              diagnosis.cause,
              diagnosis.solution,
            );
            logger.diagnostic(
              "warn",
              `Recorded repeated ${key} failures to memory (${prev.count}x)`,
            );
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
      logger.diagnostic("warn", `Consecutive tool failures: ${state.consecutiveToolFailures}`);
      const taskSnippet = input.length > 200 ? `${input.slice(0, 200)}...` : input;
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

    // Honest-stop полностью провальных пакетов: каждый вызов пакета — неудача
    // или tool-level блок (в отличие от consecutiveToolFailures выше, блоки
    // ВХОДЯТ в учёт — перебор вариантов заблокированной команды это та же
    // петля). Смешанные пакеты и успехи сбрасывают стрик: связка
    // «упал → поправил → упал» (дебаг) под него не попадает.
    // Plugin-level блоки (result.blocked, guard-rails) нейтральны по контракту
    // ToolResult.blocked — не успех и не неудача.
    if (anyToolFailed && !batchHasSuccess) {
      state.consecutiveFailedBatches++;
    } else if (batchHasSuccess) {
      state.consecutiveFailedBatches = 0;
      state.honestStopNudged = false;
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
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("exec.honest_stop", { count: state.consecutiveFailedBatches })}</system-summary>`,
      });
    }
    if (state.consecutiveFailedBatches >= HARD_STOP_FAILED_BATCHES) {
      state.retryLoopStopped = true;
      logger.diagnostic(
        "warn",
        `Retry loop hard-stopped after ${state.consecutiveFailedBatches} consecutive failed batches`,
      );
      return { interrupted: true };
    }

    // Read-only бюджет: серия пакетов только из read-only тулов без мутаций.
    // Успешные, но бесполезные fetch/read не попадают под honest-stop (тот про
    // провалы), поэтому петля «читаю и не могу остановиться» гасится отдельно.
    const batchAllReadOnly = toolCalls.length > 0 && toolCalls.every((c) => READONLY_TOOLS.has(c.name));
    if (batchAllReadOnly) {
      state.consecutiveReadOnlyBatches++;
    } else {
      state.consecutiveReadOnlyBatches = 0;
      state.readonlyNudged = false;
    }
    if (state.consecutiveReadOnlyBatches >= MAX_READONLY_BATCHES && !state.readonlyNudged) {
      state.readonlyNudged = true;
      logger.diagnostic(
        "warn",
        `Read-only exploration streak: ${state.consecutiveReadOnlyBatches} batches — directive`,
      );
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("exec.readonly_directive", { count: state.consecutiveReadOnlyBatches })}</system-summary>`,
      });
    }
    if (state.consecutiveReadOnlyBatches >= HARD_STOP_READONLY_BATCHES) {
      state.readonlyStopped = true;
      logger.diagnostic(
        "warn",
        `Read-only loop hard-stopped after ${state.consecutiveReadOnlyBatches} consecutive read-only batches`,
      );
      return { interrupted: true };
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
