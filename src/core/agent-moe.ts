import type { AppConfig } from "../config/types";
import type { LLMProvider } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import type { Logger } from "../logger/app-logger";
import type { ToolEvent, AgentPhase, AgentResult } from "./types";
import { OrchestratorClient } from "../llm/orchestrator";
import { validatePlan, applyAutoFixes } from "../modules/execution/plan-validator";
import { MoEExecutor } from "../modules/execution/moe-executor";
import { StepVerifier } from "../modules/execution/verifier";

export interface MoEDeps {
  config: AppConfig;
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  logger: Logger;
  baseDir: string;
}

/**
 * Execute the MoE (Mixture of Experts) path: plan → validate → execute → verify.
 * Returns a fallback signal when MoE cannot proceed so the caller can fall
 * back to the single-agent loop.
 */
export async function runWithMoE(
  deps: MoEDeps,
  input: string,
  fallback: () => Promise<AgentResult>,
  opts: {
    onMeta?: (meta: string) => void;
    onTool?: (ev: ToolEvent) => void;
    onPhase?: (phase: AgentPhase) => void;
  } = {},
): Promise<AgentResult> {
  const { config, llmProvider, logger, toolExecutor, baseDir } = deps;
  const { onMeta, onPhase } = opts;

  const orchestrator = new OrchestratorClient(
    {
      model: config.orchestrator.model,
      provider: config.orchestrator.provider,
    },
    llmProvider,
  );

  if (!orchestrator.isEnabled()) {
    logger.debug("MoE enabled but no orchestrator model configured — falling back to single-agent");
    return fallback();
  }

  onMeta?.("🤖 Planning with MoE mode...\n");
  onPhase?.("thinking");
  const planResult = await orchestrator.plan(input);
  onPhase?.("done");

  if ("error" in planResult) {
    logger.warn(`MoE plan failed: ${planResult.error} — falling back to single-agent`);
    return fallback();
  }

  const { plan } = planResult;
  onMeta?.(`📋 Plan created: "${plan.title}" (${plan.subtasks.length} subtasks)\n`);

  const validation = validatePlan(plan, config);
  if (!validation.valid) {
    const applied = applyAutoFixes(plan, validation.autoFixes);
    const retry = validatePlan(applied, config);
    if (!retry.valid) {
      logger.warn(
        `MoE plan validation failed: ${retry.errors.join("; ")} — falling back to single-agent`,
      );
      onMeta?.(`⚠️ Plan validation failed. Falling back to single-agent mode.\n`);
      return fallback();
    }
    Object.assign(plan, applied);
    onMeta?.(`🔧 Auto-fixed ${validation.autoFixes.length} plan issues.\n`);
  }

  const moeDeps = {
    config,
    toolRegistry: toolExecutor.getRegistry(),
    toolExecutor,
    llmProvider,
    logger,
    baseDir,
  };

  const executor = new MoEExecutor(moeDeps);
  onMeta?.(`⚙️ Executing ${plan.subtasks.length} subtasks...\n`);
  const planResults = await executor.executePlan(plan);
  onMeta?.(
    `✅ Execution complete: ${planResults.results.filter((r) => r.success).length}/${planResults.results.length} succeeded\n`,
  );

  const verifier = new StepVerifier(baseDir);
  const knownTags = ["file", "code", "shell", "research", "browser", "vision", "core"];
  const verification = await verifier.verifyMoEManifest(plan, config, knownTags);

  onPhase?.("thinking");
  let verifyResult: Awaited<ReturnType<typeof orchestrator.verifyAndMerge>>;
  try {
    verifyResult = await orchestrator.verifyAndMerge({
      plan,
      results: planResults.results.map((r) => ({
        subtaskId: r.subtaskId,
        success: r.success,
        summary: r.summary,
        result: r.result,
        error: r.error,
      })),
      verifierErrors: verification.errors,
      verifierWarnings: verification.warnings,
    });
  } catch (err: any) {
    onPhase?.("done");
    return {
      success: false,
      text: `MoE verifyAndMerge crashed: ${err.message}`,
      error: err.message,
      iterationCount: 0,
    };
  }
  onPhase?.("done");

  const outputLines: string[] = [`## MoE Execution Results\n`];
  for (const r of planResults.results) {
    const icon = r.success ? "✅" : "❌";
    outputLines.push(`${icon} **${r.subtaskId}**: ${r.summary} (${r.durationMs}ms)`);
  }
  outputLines.push("");
  if (verifyResult.type === "final") {
    outputLines.push(`**Result:** ${verifyResult.finalAnswer || "Complete"}`);
  } else {
    outputLines.push(`**Re-plan requested:** ${verifyResult.explanation || ""}`);
  }

  const failedCount = planResults.results.filter((r) => !r.success).length;
  return {
    success: failedCount === 0 && verification.success,
    text: outputLines.join("\n"),
    iterationCount: planResults.results.length,
  };
}
