import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext } from "./types";
import type { PromptBlock } from "../core/types";
import { PipelineEngine } from "../modules/pipelines/engine";
import { PipelineParser } from "../modules/pipelines/parser";
import { TemplateEngine } from "../modules/pipelines/template";
import { Agent } from "../core/agent";
import { ContextManager } from "../modules/context/manager";
import { PluginManager } from "../modules/plugins/manager";
import { HallucinationDetector } from "../modules/hallucination/detector";
import { logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";

const engine = new PipelineEngine();
const MAX_CONCURRENT = 3;
const MAX_ATTEMPTS = 3;

async function runStep(
  ctx: ToolContext,
  step: { id: string; agent: string; prompt: string },
  params: Record<string, string>,
  outputs: Record<string, { output: string }>,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const prompt = TemplateEngine.render(step.prompt, params, outputs);
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const subContextManager = new ContextManager(
        ctx.config.contextWindow,
        ctx.config.contextBudget,
      );
      const subPluginManager = new PluginManager();
      const systemPrompt: PromptBlock = {
        content: `You are a pipeline step agent ("${step.agent}"). Complete the given task using the available tools.`,
        priority: "critical",
        essential: true,
        estimatedTokens: 80,
      };
      const subDeps = {
        config: ctx.config,
        llmProvider: ctx.llmProvider!,
        toolExecutor: ctx.toolExecutor!,
        pluginManager: subPluginManager,
        contextManager: subContextManager,
        hallucinationDetector: new HallucinationDetector(ctx.baseDir, ctx.llmProvider!),
        logger: ctx.logger,
        baseDir: ctx.baseDir,
        scope: ctx.scope,
        recursionDepth: (ctx.recursionDepth ?? 0) + 1,
        promptBlocks: [systemPrompt],
      };
      const subAgent = new Agent(subDeps);
      const result = await subAgent.run(prompt);
      if (result.success) {
        return { ok: true, output: result.text };
      }
      lastError = result.error || "no output";
    } catch (e: any) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return { ok: false, output: "", error: lastError };
}

export const pipelineRunTool: ToolDefinition = {
  name: "pipeline_run",
  icon: "▶️",
  description:
    "Run a named pipeline with YAML definition. Creates a DAG of sub-agents that execute in dependency order.",
  tags: ["shell"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Pipeline name" },
      yaml: { type: "string", description: "Pipeline YAML definition with steps" },
      params: { type: "object", description: "Template params for {key} placeholders" },
    },
    required: ["name", "yaml"],
  },
  handler: async (ctx, args) => {
    const name = String(args.name || "");
    const yaml = String(args.yaml || "");
    const params = (args.params as Record<string, string>) || {};

    if (!yaml) {
      return { success: false, output: t("pipeline.invalid") };
    }

    if (!ctx.llmProvider || !ctx.toolExecutor) {
      return {
        success: false,
        output: "Pipeline cannot run: missing llmProvider or toolExecutor in context",
      };
    }

    const securityConfig = ctx.sessionContext
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;
    const maxDepth = securityConfig?.maxRecursionDepth ?? 3;
    const currentDepth = ctx.recursionDepth ?? 0;
    if (currentDepth >= maxDepth) {
      logSecurityBlock(
        ctx.sessionId,
        "bash_command",
        `Maximum recursion depth (${maxDepth}) exceeded`,
        name,
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] Maximum pipeline recursion depth (${maxDepth}) exceeded`,
      };
    }

    try {
      const pipeline = PipelineParser.parse(yaml);
      engine.reset();
      const order = engine.resolveDependencies(pipeline.steps);
      const completed = new Set<string>();
      const outputs: Record<string, { output: string }> = {};
      const logs: string[] = [];
      const failed = new Set<string>();

      while (completed.size < pipeline.steps.length) {
        const ready = engine
          .getReadySteps(pipeline.steps, completed)
          .filter((s) => !failed.has(s.id));
        if (ready.length === 0) {
          if (failed.size > 0) break;
          throw new Error(t("pipeline.circular", { stepId: order.join(", ") }));
        }

        const batch = ready.slice(0, MAX_CONCURRENT);
        const results = await Promise.all(batch.map((step) => runStep(ctx, step, params, outputs)));

        for (let i = 0; i < batch.length; i++) {
          const step = batch[i];
          const result = results[i];
          if (result.ok) {
            completed.add(step.id);
            outputs[step.id] = { output: result.output };
            engine.setStepStatus(step.id, "done");
            logs.push(`  ✓ ${step.id}: ${result.output.split("\n")[0]}`);
          } else {
            failed.add(step.id);
            engine.setStepStatus(step.id, "failed");
            logs.push(`  ✗ ${step.id}: ${result.error}`);
          }
        }

        if (failed.size > 0) break;
      }

      if (failed.size > 0) {
        return {
          success: false,
          output: `Pipeline "${pipeline.name}" failed. Executed ${completed.size}/${pipeline.steps.length} steps.\n${logs.join("\n")}`,
        };
      }

      return {
        success: true,
        output: `Pipeline "${pipeline.name}" completed successfully (${completed.size} steps).\n${logs.join("\n")}`,
      };
    } catch (e: any) {
      return { success: false, output: `Pipeline error: ${e.message}` };
    }
  },
};
