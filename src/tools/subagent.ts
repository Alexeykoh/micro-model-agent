import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext, ToolScope } from "./types";
import { Agent } from "../core/agent";
import { ContextManager } from "../modules/context/manager";
import { HallucinationDetector } from "../modules/hallucination/detector";
import { PluginManager } from "../modules/plugins/manager";
import type { PromptBlock } from "../core/types";
import { logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";

export const subagentTool: ToolDefinition = {
  name: "subagent",
  description:
    "Spawn an isolated sub-agent to work on a task independently. The sub-agent has its own context and executes autonomously. Use for parallel work or complex sub-tasks.",
  tags: ["code"],
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Task description for the sub-agent",
      },
      context: {
        type: "string",
        description: "Optional context or constraints",
      },
      expert_tag: {
        type: "string",
        description: "Expert tag for tool filtering and model selection",
      },
      allowed_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read and write",
      },
      read_only_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read but not write",
      },
      shared_context: {
        type: "string",
        description: "Shared context/rules passed to the sub-agent",
      },
      max_tokens: {
        type: "number",
        description: "Maximum tokens for the sub-agent response",
      },
      tool_tags: {
        type: "array",
        items: { type: "string" },
        description: "Tool tags to expose to the sub-agent",
      },
    },
    required: ["task"],
  },
  handler: async (ctx: ToolContext, args) => {
    const task = String(args.task || "");
    const context = String(args.context || "");

    if (!task) {
      return { success: false, output: t("tool.name_or_task") };
    }

    // Get session-specific security config
    const securityConfig = ctx.sessionContext 
      ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
      : ctx.config.security;
    
    // Security check: limit recursion depth
    const maxDepth = securityConfig?.maxRecursionDepth ?? 3;
    const currentDepth = ctx.recursionDepth ?? 0;

    if (currentDepth >= maxDepth) {
      logSecurityBlock(
        ctx.sessionId,
        "bash_command",
        `Maximum recursion depth (${maxDepth}) exceeded`,
        task,
      );
      return {
        success: false,
        output: `[SECURITY BLOCKED] Maximum sub-agent recursion depth (${maxDepth}) exceeded`,
      };
    }

    const scope: ToolScope | undefined =
      args.allowed_files || args.read_only_files
        ? {
            allowed_files: (args.allowed_files as string[]) || [],
            read_only_files: (args.read_only_files as string[]) || [],
          }
        : ctx.scope;

    const toolTags = args.tool_tags ? (args.tool_tags as string[]) : undefined;

    if (!ctx.llmProvider || !ctx.toolExecutor) {
      return {
        success: false,
        output:
          "Sub-agent cannot run: missing llmProvider or toolExecutor in context",
      };
    }

    // Defensive guard: if the caller requested specific tool tags but none of the
    // registered tools match, the sub-agent would have zero tools and would
    // hallucinate instead of acting. Warn the caller so it can correct the tags.
    if (toolTags && toolTags.length > 0) {
      const matched = ctx.toolExecutor.getToolDefinitions(toolTags);
      if (matched.length === 0) {
        return {
          success: false,
          output: `[SECURITY BLOCKED] No tools match the requested tool_tags: [${toolTags.join(", ")}]. Check the subagent tool_tags parameter and retry with valid tags (e.g. "file", "code", "shell", "research").`,
        };
      }
    }

    try {
      const subContextManager = new ContextManager(
        ctx.config.contextWindow,
        ctx.config.contextBudget,
      );
      const subPluginManager = new PluginManager();
      const hallucinationDetector = new HallucinationDetector(
        ctx.baseDir,
        ctx.llmProvider,
      );

      const systemPrompt: PromptBlock = {
        content: `You are a sub-agent working on a specific task. ${context ? `Context: ${context}` : ""}`,
        priority: "critical",
        essential: true,
        estimatedTokens: 100,
      };

       const subDeps = {
         config: ctx.config,
         llmProvider: ctx.llmProvider,
         toolExecutor: ctx.toolExecutor,
         pluginManager: subPluginManager,
         contextManager: subContextManager,
         hallucinationDetector,
         logger: ctx.logger,
         baseDir: ctx.baseDir,
         scope,
         toolTags,
         promptBlocks: [systemPrompt],
         recursionDepth: currentDepth + 1, // Increment recursion depth for sub-agent
       };

      const subAgent = new Agent(subDeps);
      const fullTask = context ? `${task}\n\nContext: ${context}` : task;
      const result = await subAgent.run(fullTask);

      if (result.success) {
        return {
          success: true,
          output: `Sub-agent completed:\n${result.text}\n\nIterations: ${result.iterationCount}`,
        };
      } else {
        return {
          success: false,
          output: `Sub-agent failed: ${result.error}\nPartial output: ${result.text}`,
        };
      }
    } catch (e: any) {
      return { success: false, output: `Sub-agent error: ${e.message}` };
    }
  },
};
