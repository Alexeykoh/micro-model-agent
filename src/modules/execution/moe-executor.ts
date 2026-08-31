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
import { isTransientError } from "./transient-error";
import { sleep } from "../../utils/sleep";
import { backoffDelay } from "../../utils/retry";
import { errMsg } from "../../utils";

export const MAX_SCOPE_EXPANSION_CYCLES = 2;

/** Router decision on a sub-agent's scope request (see OrchestratorClient.resolveScopeRequest). */
export type ScopeDecision =
  | { action: "approve"; write: string[]; read: string[] }
  | { action: "reject" };

/** Uniform interrupt error recognized by the agent loop (err.name === "AbortError"). */
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
      "\n\nIf relevant skills are available, consider loading one with load_skill for expert guidance.";
  }
  return errorDetail;
}

export interface MoEExecutorDeps {
  config: AppConfig;
  toolRegistry: ToolRegistry;
  toolExecutor: import("../../tools/executor").ToolExecutor;
  llmProvider: LLMProvider;
  logger: Logger;
  baseDir: string;
  /** Router callback for scope decisions; absent = scope requests are plain failures. */
  onScopeRequest?: (subtaskId: string, req: ScopeRequestBody) => Promise<ScopeDecision>;
  /** Abort signal — queued subtasks are skipped, waves stop at the barrier. */
  signal?: AbortSignal;
  /** Tool events (start/end) forwarded to the renderer around each subtask. */
  onTool?: (ev: import("../../core/types").ToolEvent) => void;
  /** Observability event sink (moe_subtask) — wired to session.jsonl by runWithMoE. */
  onEvent?: (event: { type: "moe_subtask"; data: Record<string, unknown> }) => void;
  /** Real session id for audit log / artifacts (was hardcoded "moe"). */
  sessionId?: string;
}

/** Aggregated token usage per expert_tag (cost attribution, Plan 4.2). */
export interface TagUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  subtasks: number;
}

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
  let lastError = "";
  const stuckDetector = new StuckDetector(maxAttempts * 2, maxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
          llmProvider: deps.llmProvider,
          toolExecutor: deps.toolExecutor,
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
          // Structured field from the subagent tool — locale-independent
          // (parsing the localized output string broke under ru).
          const abs = result.artifactPath ?? "";
          if (abs) {
            const store = new ArtifactStore({
              baseDir: deps.baseDir,
              sessionId: deps.sessionId || "moe",
            });
            const full = store.read(abs.split(/[\\/]/).pop() || ""); // file name only, scoped to root
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

      // Inject actionable hints into the next retry's prompt
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
        await sleep(delay);
        continue;
      }

      // Non-transient failure — build detailed error with hints
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

      // User interrupt (Esc) is NEVER transient — propagate immediately so
      // the wave barrier and the agent loop see the abort instead of retrying.
      if (e?.name === "AbortError") {
        throw e;
      }

      if (isTransientError(lastError) && attempt < maxAttempts) {
        const delay = backoffDelay(attempt - 1, 1000, 8000);
        deps.logger.debug(
          `Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: ${lastError}`,
        );
        await sleep(delay);
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

  // Exhausted retries — build detailed failure
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

export class MoEExecutor {
  private deps: MoEExecutorDeps;
  private usageByTag = new Map<string, TagUsage>();

  constructor(deps: MoEExecutorDeps) {
    this.deps = deps;
  }

  /** Aggregated token usage per expert_tag across all executed subtasks. */
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

  async executePlan(
    plan: MoEPlan,
    opts?: {
      /** Selective re-plan (Plan 5.1): subtasks whose ids are listed here are
       * NOT re-executed — their previous successful results are injected as
       * `carriedResults` so dependencies of re-executed subtasks resolve. */
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
    const waves = topologicalSort(subtasks);

    if (waves.length === 0) {
      return {
        success: false,
        results: [],
        errors: ["Failed to topologically sort subtasks (possible cycle)"],
        warnings: [],
      };
    }

    // Verify all subtasks are included — catch silent drops from unresolved dependencies
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

      // Cap concurrent subtasks per wave (rateLimits.maxParallelTasks, default 5).
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
          // Checked after acquiring so subtasks queued behind an in-flight one
          // never start once Esc was pressed mid-wave.
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
      // Wave barrier: once interrupted, stop before the next wave instead of
      // starting new sub-agents after Esc.
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
   * Scope expansion protocol (spec §Post-MVP): a failed sub-agent's
   * <scope-request> goes to the Router; approve extends the subtask scope and
   * re-executes ONLY this subtask, reject fails it (it can still be fixed by
   * a full re-plan). Expansion is capped — never automatic.
   */
  private async resolveScopeAndRetry(
    subtask: MoESubtask,
    failed: SubtaskResult,
    depResults: Map<string, SubtaskResult>,
    sharedContext?: { rules: string[]; refs: string[] },
  ): Promise<SubtaskResult> {
    let current = failed;
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

      subtask.allowed_files = uniq([...(subtask.allowed_files || []), ...decision.write]);
      subtask.read_only_files = uniq([...(subtask.read_only_files || []), ...decision.read]);
      this.deps.logger.info?.(
        `MoE: approved scope expansion for "${subtask.id}": +write [${decision.write.join(", ")}] +read [${decision.read.join(", ")}]`,
      );

      const retry = await executeSubtask(
        subtask,
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
