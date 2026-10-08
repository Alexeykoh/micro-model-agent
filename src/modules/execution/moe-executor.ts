// MoE-исполнитель: волны подзадач по топосорту, ретраи, scope-протокол, usage по тегам.
import type { MoEPlan, MoESubtask, SubtaskResult, PlanResult, ScopeRequestBody } from "./types";
import type { AppConfig, ExpertConfig } from "../../config/types";
import { getExpertConfig } from "../../config/experts";
import { filterToolsByTags } from "../../tools/filter-tools";
import type { ToolRegistry } from "../../tools/registry";
import type { LLMProvider } from "../../llm/provider";
import type { Logger } from "../../logger/app-logger";
import { StuckDetector } from "./stuck-detector";
import { t } from "../../i18n/index";
import { ArtifactStore } from "../artifacts/store";
import { buildInputSection } from "./input-from";
import { parseScopeRequest } from "../../tools/scope-request";
import { resolveExpertProvider } from "./expert-provider";
import { isTransientError } from "./transient-error";
import { sleep } from "../../utils/sleep";
import { backoffDelay } from "../../utils/retry";
import { errMsg } from "../../utils";

/** Макс. циклов расширения scope на подзадачу. */
export const MAX_SCOPE_EXPANSION_CYCLES = 2;

/** Решение роутера по scope-запросу сабагента (см. OrchestratorClient.resolveScopeRequest). */
export type ScopeDecision =
  | { action: "approve"; write: string[]; read: string[] }
  | { action: "reject" };

/** Униформная ошибка прерывания для цикла агента (err.name === "AbortError"). */
export function newAbortError(): Error {
  const e = new Error(t("tool.aborted", { name: "MoE execution" }));
  e.name = "AbortError";
  return e;
}

/**
 * Сборка детального сообщения об ошибке подзадачи: базовый текст + подсказки
 * stuck-детектора + совет про load_skill. Дублировался 2× в executeSubtask.
 */
function buildErrorDetail(stuckDetector: StuckDetector, baseError: string, lastError: string): string {
  const hints = stuckDetector.getActionableHints();
  let errorDetail = baseError;
  if (hints.length > 0) {
    errorDetail += `\n\n${t("exec.hints", { hints: hints.map((h) => `- ${h}`).join("\n") })}`;
  }
  if (lastError) {
    errorDetail +=
      `\n\n${t("exec.skills_hint")}`;
  }
  return errorDetail;
}

/** Зависимости исполнителя: конфиг, реестры тулов, провайдер, scope-роутер, abort, события. */
export interface MoEExecutorDeps {
  config: AppConfig;
  toolRegistry: ToolRegistry;
  toolExecutor: import("../../tools/executor").ToolExecutor;
  llmProvider: LLMProvider;
  logger: Logger;
  baseDir: string;
  /** Роутер-колбэк для scope-решений; нет — scope-запросы идут обычными фейлами. */
  onScopeRequest?: (subtaskId: string, req: ScopeRequestBody) => Promise<ScopeDecision>;
  /** Abort-сигнал — queued подзадачи скипаются, волны встают на барьере. */
  signal?: AbortSignal;
  /** События тулов (start/end), форвардимые рендереру вокруг каждой подзадачи. */
  onTool?: (ev: import("../../core/types").ToolEvent) => void;
  /** Сток событий наблюдаемости (moe_subtask) — runWithMoE вяжет на session.jsonl. */
  onEvent?: (event: { type: "moe_subtask"; data: Record<string, unknown> }) => void;
  /** Реальный id сессии для audit-лога / артефактов (был хардкод "moe"). */
  sessionId?: string;
}

/** Агрегированный usage токенов по expert_tag (атрибуция стоимости, Plan 4.2). */
export interface TagUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  subtasks: number;
}

/** Топосорт подзадач в волны готовых (зависимости удовлетворены). Пусто при цикле. */
export function topologicalSort(subtasks: MoESubtask[]): MoESubtask[][] {
  const sorted: MoESubtask[][] = [];
  const remaining = new Set(subtasks.map((s) => s.id));
  const subtaskMap = new Map(subtasks.map((s) => [s.id, s]));

  while (remaining.size > 0) {
    const ready: MoESubtask[] = [];
    for (const id of remaining) {
      const sub = subtaskMap.get(id)!;
      const depsSatisfied = (sub.depends_on || []).every((d) => !remaining.has(d));
      if (depsSatisfied) {
        ready.push(sub);
      }
    }

    if (ready.length === 0) {
      break;
    }

    sorted.push(ready);
    for (const r of ready) {
      remaining.delete(r.id);
    }
  }

  return sorted;
}

async function executeSubtask(
  subtask: MoESubtask,
  deps: MoEExecutorDeps,
  depResults: Map<string, SubtaskResult>,
  sharedContext?: { rules: string[]; refs: string[] },
  onUsage?: (expertTag: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void,
): Promise<SubtaskResult> {
  const startTime = Date.now();
  const expertConfig: ExpertConfig | undefined = getExpertConfig(deps.config, subtask.expert_tag);

  if (!expertConfig) {
    return {
      subtaskId: subtask.id,
      success: false,
      summary: `Unknown expert_tag: ${subtask.expert_tag}`,
      result: "",
      error: `No expert config found for tag "${subtask.expert_tag}"`,
      durationMs: Date.now() - startTime,
    };
  }

  const subagentTool = deps.toolRegistry.get("subagent");
  if (!subagentTool) {
    return {
      subtaskId: subtask.id,
      success: false,
      summary: "Subagent tool not registered",
      result: "",
      error: "Subagent tool not found in registry",
      durationMs: Date.now() - startTime,
    };
  }

  // Изолированный исполнитель на сабтаску: волны MoE бегут конкурентно, а
  // общий executor не конкурентно-безопасен (scope/recursionDepth/cleanup на
  // общем ctx). Форк даёт каждой сабтаске свои — без гонок между волнами.
  // `fork` опционален: тестовые/минимальные исполнители его не несут.
  const subtaskExecutor = deps.toolExecutor.fork ? deps.toolExecutor.fork() : deps.toolExecutor;

  const allTools = deps.toolRegistry.getAll();
  const filteredTools = filterToolsByTags(allTools, expertConfig.tool_tags);

  if (filteredTools.length === 0) {
    return {
      subtaskId: subtask.id,
      success: false,
      summary: `No tools available for expert "${subtask.expert_tag}" (tags: ${expertConfig.tool_tags.join(", ")})`,
      result: "",
      error: "No matching tools",
      durationMs: Date.now() - startTime,
    };
  }

  const maxAttempts = expertConfig.max_attempts || 3;
  // Модель эксперта: отличается от активной → выделенный провайдер на активном
  // провайдере; совпадает/пусто → общий провайдер (без лишней сборки).
  const expertProvider = resolveExpertProvider(
    deps.config,
    expertConfig.model,
    deps.llmProvider,
    deps.logger,
    () => deps.sessionId,
  );
  let lastError = "";
  const stuckDetector = new StuckDetector(maxAttempts * 2, maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Стабильный id между попытками: передача `attempt` ресетила состояние
    // детектора на каждом ретрае (новый stepId → resetStepState), ошибки тулов
    // не накапливались и exhausted-retries диагностика всегда пустовала.
    stuckDetector.recordIteration(1);
    try {
      const allowedFiles = subtask.allowed_files || [];
      const readOnlyFiles = subtask.read_only_files || [];

      const scopePrompt =
        allowedFiles.length > 0 || readOnlyFiles.length > 0
          ? `\n\nAllowed files to write: ${allowedFiles.join(", ") || "(none)"}\nRead-only files: ${readOnlyFiles.join(", ") || "(none)"}`
          : "";

      const sharedRules = sharedContext?.rules;
      const sharedContextPrompt =
        sharedRules && sharedRules.length > 0
          ? `\n\nShared rules:\n${sharedRules.map((r) => `- ${r}`).join("\n")}`
          : "";

      const taskPrompt = `${subtask.description}\n\nExpected output: ${subtask.expected_output}\nSuccess criteria:\n${(subtask.success_criteria || []).map((c: string) => `- ${c}`).join("\n")}${scopePrompt}${sharedContextPrompt}${buildInputSection(subtask, depResults, deps.config.subagent?.maxSummaryChars ?? 2000)}`;

      const subagentArgs: Record<string, unknown> = {
        task: taskPrompt,
        allowed_files: allowedFiles,
        read_only_files: readOnlyFiles,
        tool_tags: expertConfig.tool_tags,
      };
      if (deps.config.subagent?.resultMode === "file") {
        subagentArgs.result_mode = "file";
        subagentArgs.artifact_name = subtask.id;
      }

      const subagentStart = Date.now();
      deps.onTool?.({
        type: "start",
        tool: "subagent",
        args: { subtask: subtask.id, description: subtask.description },
      });
      const result = await subagentTool.handler(
        {
          config: deps.config,
          baseDir: deps.baseDir,
          logger: deps.logger,
          llmProvider: expertProvider,
          toolExecutor: subtaskExecutor,
          sessionId: deps.sessionId || "moe",
        },
        subagentArgs,
      );
      if (result.usage) {
        onUsage?.(subtask.expert_tag, result.usage);
      }
      deps.onTool?.({
        type: "end",
        tool: "subagent",
        args: { subtask: subtask.id, description: subtask.description },
        duration: Date.now() - subagentStart,
        error: !result.success,
      });

      if (result.success) {
        if (deps.config.subagent?.resultMode === "file") {
          // Структурное поле из тула subagent — языконезависимо (парсинг
          // локализованной строки вывода ломался под ru).
          const abs = result.artifactPath ?? "";
          if (abs) {
            const store = new ArtifactStore({
              baseDir: deps.baseDir,
              sessionId: deps.sessionId || "moe",
            });
            const full = store.read(abs.split(/[\\/]/).pop() || ""); // только имя файла, в jail root
            deps.logger.debug(
              `MoE subtask "${subtask.id}" attached artifact ${abs} (${full?.length ?? 0} chars) to Router`,
            );
            return {
              subtaskId: subtask.id,
              success: true,
              summary: `Artifact: ${abs}`,
              result: full ?? result.output,
              durationMs: Date.now() - startTime,
            };
          }
        }
        return {
          subtaskId: subtask.id,
          success: true,
          summary: `Completed: ${subtask.id}`,
          result: result.output,
          durationMs: Date.now() - startTime,
        };
      }

      lastError = result.output;
      stuckDetector.recordToolError("subagent", result.output);

      // Инжектим actionable-хинты в промпт следующего ретрая
      if (attempt < maxAttempts) {
        const hints = stuckDetector.getActionableHints();
        const recovery = stuckDetector.getRecoveryMessage();
        if (hints.length > 0) {
          deps.logger.debug(`Hint for subtask "${subtask.id}" retry: ${hints.join("; ")}`);
        }
        if (recovery) {
          deps.logger.debug(`Recovery for subtask "${subtask.id}": ${recovery}`);
        }
      }

      if (isTransientError(lastError) && attempt < maxAttempts) {
        const delay = backoffDelay(attempt - 1, 1000, 8000);
        deps.logger.debug(
          `Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: transient error`,
        );
        await sleep(delay, deps.signal);
        continue;
      }

      // Нетранзиентный фейл — собираем детальную ошибку с хинтами
      const errorDetail = buildErrorDetail(stuckDetector, result.output, lastError);

      return {
        subtaskId: subtask.id,
        success: false,
        summary: `Failed: ${subtask.id}`,
        result: result.output,
        error: errorDetail,
        scopeRequest: parseScopeRequest(result.output) ?? undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (e: any) {
      lastError = e.message;
      stuckDetector.recordToolError("subagent", e.message);

      // Прерывание юзера (Esc) — НИКОГДА не транзиент: пробрасываем сразу, чтобы
      // барьер волны и цикл агента увидели abort вместо ретрая.
      if (e?.name === "AbortError") {
        throw e;
      }

      if (isTransientError(lastError) && attempt < maxAttempts) {
        const delay = backoffDelay(attempt - 1, 1000, 8000);
        deps.logger.debug(
          `Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: ${lastError}`,
        );
        await sleep(delay, deps.signal);
        continue;
      }

      const errorDetail = buildErrorDetail(stuckDetector, e.message, lastError);

      return {
        subtaskId: subtask.id,
        success: false,
        summary: `Error: ${subtask.id}`,
        result: "",
        error: errorDetail,
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Ретраи исчерпаны — собираем итоговый фейл
  const stuckReason = stuckDetector.getStuckReason();
  let finalError = lastError;
  if (stuckReason) {
    finalError += `\n${stuckReason}`;
  }

  return {
    subtaskId: subtask.id,
    success: false,
    summary: `Failed after ${maxAttempts} attempts: ${subtask.id}`,
    result: "",
    error: finalError,
    durationMs: Date.now() - startTime,
  };
}

/** Исполнитель MoE-плана: волны, параллелизм, scope-ретраи, usage по тегам. */
export class MoEExecutor {
  private deps: MoEExecutorDeps;
  private usageByTag = new Map<string, TagUsage>();

  constructor(deps: MoEExecutorDeps) {
    this.deps = deps;
  }

  /** Агрегированный usage токенов по expert_tag всех исполненных подзадач. */
  getUsageByTag(): Record<string, TagUsage> {
    return Object.fromEntries(this.usageByTag);
  }

  private recordUsage(
    expertTag: string,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
  ): void {
    const entry = this.usageByTag.get(expertTag) ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      subtasks: 0,
    };
    entry.promptTokens += usage.promptTokens;
    entry.completionTokens += usage.completionTokens;
    entry.totalTokens += usage.totalTokens;
    entry.subtasks += 1;
    this.usageByTag.set(expertTag, entry);
  }

  /**
   * Исполняет план волнами топосорта с капом параллелизма. Поддерживает
   * селективный re-plan (skipIds + carriedResults). Abort (Esc) останавливает
   * на барьере волны.
   * @param opts.skipIds подзадачи, НЕ переисполняемые — их прошлые успешные
   * результаты инжектятся как carriedResults, чтобы резолвились зависимости
   * переисполняемых.
   */
  async executePlan(
    plan: MoEPlan,
    opts?: {
      skipIds?: ReadonlySet<string>;
      carriedResults?: SubtaskResult[];
    },
  ): Promise<PlanResult> {
    const skipIds = opts?.skipIds;
    const carried = opts?.carriedResults ?? [];
    const results: SubtaskResult[] = carried.map((r) => ({ ...r }));
    const errors: string[] = [];
    const warnings: string[] = [];

    const subtasks =
      skipIds && skipIds.size > 0 ? plan.subtasks.filter((s) => !skipIds.has(s.id)) : plan.subtasks;

    // Селективный re-plan, где все подзадачи уже успешны: исполнять нечего.
    // Раньше проваливалось в topologicalSort([]) и репортилось bogus
    // "possible cycle", сжигая оставшиеся re-plan циклы.
    if (subtasks.length === 0) {
      return { success: true, results, errors: [], warnings };
    }

    const waves = topologicalSort(subtasks);

    if (waves.length === 0) {
      return {
        success: false,
        results: [],
        errors: ["Failed to topologically sort subtasks (possible cycle)"],
        warnings: [],
      };
    }

    // Проверяем, что все подзадачи вошли — ловим молчаливые дропы от висячих зависимостей
    const sortedCount = waves.flat().length;
    if (sortedCount < subtasks.length) {
      const missing = subtasks
        .filter((s) => !waves.flat().some((w) => w.id === s.id))
        .map((s) => s.id);
      return {
        success: false,
        results: [],
        errors: [
          `Missing subtasks after topological sort: ${missing.join(", ")} (dangling or invalid depends_on)`,
        ],
        warnings: [],
      };
    }

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx];
      const depResults = new Map(results.map((r) => [r.subtaskId, r]));

      // Кап конкурентных подзадач на волну (rateLimits.maxParallelTasks, по умолчанию 5).
      const maxParallel =
        this.deps.config?.security?.rateLimits?.maxParallelTasks ?? 5;
      let active = 0;
      const waiters: Array<() => void> = [];
      const acquire = () =>
        active < maxParallel
          ? Promise.resolve(active++)
          : new Promise<number>((resolve) => waiters.push(() => resolve(active++)));
      const release = () => {
        active--;
        const next = waiters.shift();
        if (next) next();
      };

      const wavePromises = wave.map(async (subtask) => {
        await acquire();
        if (this.deps.signal?.aborted) {
          // Проверяем после acquire: подзадачи, queued за летящей, не стартуют,
          // если Esc нажат посреди волны.
          release();
          throw newAbortError();
        }
        this.deps.onEvent?.({
          type: "moe_subtask",
          data: { subtaskId: subtask.id, expertTag: subtask.expert_tag, status: "start" },
        });
        let result: SubtaskResult;
        try {
          result = await executeSubtask(
            subtask,
            this.deps,
            depResults,
            plan.shared_context,
            (tag, usage) => this.recordUsage(tag, usage),
          );
          if (!result.success && this.deps.onScopeRequest) {
            result = await this.resolveScopeAndRetry(subtask, result, depResults, plan.shared_context);
          }
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") throw e;
          result = {
            subtaskId: subtask.id,
            success: false,
            summary: `Unhandled error: ${subtask.id}`,
            result: "",
            error: errMsg(e),
            durationMs: 0,
          };
        } finally {
          release();
        }
        this.deps.onEvent?.({
          type: "moe_subtask",
          data: {
            subtaskId: subtask.id,
            expertTag: subtask.expert_tag,
            status: result.success ? "done" : "failed",
            durationMs: result.durationMs,
            summary: result.summary,
          },
        });
        results.push(result);
        return result;
      });

      await Promise.all(wavePromises);
      // Барьер волны: при прерывании встаём перед следующей волной, а не
      // стартуем новых сабагентов после Esc.
      if (this.deps.signal?.aborted) throw newAbortError();
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      errors.push(...failed.map((f) => `[${f.subtaskId}] ${f.error || f.summary}`));
    }

    return {
      success: failed.length === 0,
      results,
      errors,
      warnings,
      ...(carried.length > 0 ? { carriedSubtaskIds: carried.map((r) => r.subtaskId) } : {}),
    };
  }

  /**
   * Scope-протокол (спек §Post-MVP): <scope-request> упавшего сабагента идёт
   * роутеру; approve расширяет scope подзадачи и переисполняет ТОЛЬКО её,
   * reject фейлит её (чинится полным re-plan). Расширение капировано, не
   * автоматически.
   */
  private async resolveScopeAndRetry(
    subtask: MoESubtask,
    failed: SubtaskResult,
    depResults: Map<string, SubtaskResult>,
    sharedContext?: { rules: string[]; refs: string[] },
  ): Promise<SubtaskResult> {
    let current = failed;
    // Расширение scope применяем к ЛОКАЛЬНОЙ копии: оригинальный объект плана
    // остаётся неизменным для verifier/re-plan (иначе верификация видит scope,
    // которого не было в утверждённом плане).
    let scoped = subtask;
    for (let cycle = 0; cycle < MAX_SCOPE_EXPANSION_CYCLES; cycle++) {
      const req = current.scopeRequest;
      if (!req) return current;

      const decision = await this.deps.onScopeRequest!(subtask.id, req);
      if (decision.action !== "approve") {
        this.deps.logger.info?.(
          `MoE: router rejected scope request for "${subtask.id}" (${req.reason})`,
        );
        return {
          ...current,
          error: `${current.error}\nRouter rejected scope request for files: ${req.files.join(", ")}`,
        };
      }

      scoped = {
        ...scoped,
        allowed_files: uniq([...(scoped.allowed_files || []), ...decision.write]),
        read_only_files: uniq([...(scoped.read_only_files || []), ...decision.read]),
      };
      this.deps.logger.info?.(
        `MoE: approved scope expansion for "${subtask.id}": +write [${decision.write.join(", ")}] +read [${decision.read.join(", ")}]`,
      );

      const retry = await executeSubtask(
        scoped,
        this.deps,
        depResults,
        sharedContext,
        (tag, usage) => this.recordUsage(tag, usage),
      );
      if (retry.success || !retry.scopeRequest) return retry;
      current = retry;
    }

    return {
      ...current,
      summary: `Failed after ${MAX_SCOPE_EXPANSION_CYCLES} scope expansions: ${subtask.id}`,
      error: `${current.error}\nScope expansion limit (${MAX_SCOPE_EXPANSION_CYCLES}) reached`,
    };
  }
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
