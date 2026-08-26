import type { MoEPlan, MoESubtask, SubtaskResult, PlanResult } from "./types";
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

const TRANSIENT_ERROR_PATTERNS = [
  "timeout",
  "Timeout",
  "TIMEOUT",
  "5xx",
  "500",
  "502",
  "503",
  "network",
  "Network",
  "ECONNREFUSED",
  "ECONNRESET",
  "fetch failed",
  "abort",
  "Abort",
];

function isTransientError(error: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((p) => error.includes(p));
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
          const pathMatch = result.output.match(/saved to artifact: (.+)/);
          const abs = pathMatch ? pathMatch[1].trim() : "";
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
        durationMs: Date.now() - startTime,
      };
    } catch (e: any) {
      lastError = e.message;
      stuckDetector.recordToolError("subagent", e.message);

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
        let result: SubtaskResult;
        try {
          result = await executeSubtask(subtask, this.deps, depResults);
        } catch (e) {
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
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      errors.push(...failed.map((f) => `[${f.subtaskId}] ${f.error || f.summary}`));
    }

    return { success: failed.length === 0, results, errors, warnings };
  }
}
