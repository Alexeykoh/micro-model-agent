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

const TRANSIENT_ERROR_PATTERNS = [
  "timeout",
  "Timeout",
  "TIMEOUT",
  /\b(429|500|502|503|504)\b/,
  "network",
  "Network",
  "ECONNREFUSED",
  "ECONNRESET",
  "fetch failed",
];

function isTransientError(error: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((p) =>
    typeof p === "string" ? error.includes(p) : p.test(error),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

      const taskPrompt = `${subtask.description}\n\nExpected output: ${subtask.expected_output}\nSuccess criteria:\n${(subtask.success_criteria || []).map((c: string) => `- ${c}`).join("\n")}${scopePrompt}${buildInputSection(subtask, depResults, deps.config.subagent?.maxSummaryChars ?? 2000)}`;

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

      const result = await subagentTool.handler(
        {
          config: deps.config,
          baseDir: deps.baseDir,
          logger: deps.logger,
          llmProvider: deps.llmProvider,
          toolExecutor: deps.toolExecutor,
          sessionId: "moe",
        },
        subagentArgs,
      );

      if (result.success) {
        if (deps.config.subagent?.resultMode === "file") {
          // Structured field from the subagent tool — locale-independent
          // (parsing the localized output string broke under ru).
          const abs = result.artifactPath ?? "";
          if (abs) {
            const store = new ArtifactStore({
              baseDir: deps.baseDir,
              sessionId: "moe",
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
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        deps.logger.debug(
          `Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: transient error`,
        );
        await sleep(delay);
        continue;
      }

      // Non-transient failure — build detailed error with hints
      const hints = stuckDetector.getActionableHints();
      let errorDetail = result.output;
      if (hints.length > 0) {
        errorDetail += `\n\n${t("exec.hints", { hints: hints.map((h) => `- ${h}`).join("\n") })}`;
      }
      if (lastError) {
        errorDetail +=
          "\n\nIf relevant skills are available, consider loading one with load_skill for expert guidance.";
      }

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
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        deps.logger.debug(
          `Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: ${lastError}`,
        );
        await sleep(delay);
        continue;
      }

      const hints = stuckDetector.getActionableHints();
      let errorDetail = e.message;
      if (hints.length > 0) {
        errorDetail += `\n\n${t("exec.hints", { hints: hints.map((h) => `- ${h}`).join("\n") })}`;
      }
      if (lastError) {
        errorDetail +=
          "\n\nIf relevant skills are available, consider loading one with load_skill for expert guidance.";
      }

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

  constructor(deps: MoEExecutorDeps) {
    this.deps = deps;
  }

  async executePlan(plan: MoEPlan): Promise<PlanResult> {
    const results: SubtaskResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    const waves = topologicalSort(plan.subtasks);

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
    if (sortedCount < plan.subtasks.length) {
      const missing = plan.subtasks
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
        let result: SubtaskResult;
        try {
          result = await executeSubtask(subtask, this.deps, depResults);
          if (!result.success && this.deps.onScopeRequest) {
            result = await this.resolveScopeAndRetry(subtask, result, depResults);
          }
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") throw e;
          result = {
            subtaskId: subtask.id,
            success: false,
            summary: `Unhandled error: ${subtask.id}`,
            result: "",
            error: e instanceof Error ? e.message : String(e),
            durationMs: 0,
          };
        } finally {
          release();
        }
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

    return { success: failed.length === 0, results, errors, warnings };
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

      const retry = await executeSubtask(subtask, this.deps, depResults);
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
