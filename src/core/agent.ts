import type { LLMProvider } from "../llm/provider";
import type { ToolExecutor } from "../tools/executor";
import type { PluginManager } from "../modules/plugins/manager";
import type { ContextManager, Message } from "../modules/context/manager";
import type { HallucinationDetector } from "../modules/hallucination/detector";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";
import type { ToolScope } from "../tools/types";
import type { PromptBlock } from "./types";
import type { ToolCall, ToolEvent, AgentPhase, LLMResponse } from "./types";
import type { SessionManager } from "../modules/session/manager";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { PromptBuilder } from "./prompt-builder";
import { OrchestratorClient } from "../llm/orchestrator";
import {
  validatePlan,
  applyAutoFixes,
} from "../modules/execution/plan-validator";
import { MoEExecutor } from "../modules/execution/moe-executor";
import { StepVerifier } from "../modules/execution/verifier";

const TOOL_RESULT_MAX_TOKENS_RATIO = 0.3;
const TOOL_RESULT_ABSOLUTE_MAX_CHARS = 15000;

export interface AgentDeps {
  config: AppConfig;
  llmProvider: LLMProvider;
  toolExecutor: ToolExecutor;
  pluginManager: PluginManager;
  contextManager: ContextManager;
  hallucinationDetector: HallucinationDetector;
  logger: Logger;
  baseDir: string;
  scope?: ToolScope;
  toolTags?: string[];
  promptBlocks: PromptBlock[];
  /**
   * Dynamic prompt blocks (e.g. the plan checklist) that may appear after the
   * system prompt was first built. Refreshed into the system prompt before each
   * LLM call so mid-run state (a created plan) stays visible to the model.
   */
  getDynamicPromptBlocks?: () => PromptBlock[];
  /**
   * Final audit callback. Returns null when no plan is active. When a plan is
   * active and incomplete, the loop refuses to terminate and re-injects the
   * audit warning so the model can finish the remaining steps.
   */
  finalAudit?: () => Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null>;
  sessionManager?: SessionManager;
  /**
   * One-shot headless mode: exit on the first final answer instead of
   * retrying empty responses, so the agent terminates immediately once done.
   */
  exitOnComplete?: boolean;
}

export interface AgentResult {
  success: boolean;
  text: string;
  error?: string;
  iterationCount: number;
  contextUsed?: number;
  contextLimit?: number;
}

export class Agent {
  private deps: AgentDeps;
  private systemPromptAdded = false;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  private setScope(): void {
    const executor = this.deps.toolExecutor as any;
    if (executor && executor.ctx && this.deps.scope) {
      executor.ctx.scope = this.deps.scope;
    }
  }

  private buildSystemPrompt(): { prompt: string; excluded: string[] } {
    const systemBudget = Math.floor(
      this.deps.config.contextWindow *
        this.deps.config.contextBudget.systemPrompt,
    );
    const builder = new PromptBuilder(systemBudget);
    builder.addBlocks(this.deps.promptBlocks);
    const dynamic = this.deps.getDynamicPromptBlocks?.() ?? [];
    if (dynamic.length > 0) {
      builder.addBlocks(dynamic);
    }
    const pluginBlocks: PromptBlock[] = (
      this.deps.pluginManager.runOnBuildPrompt?.() ?? []
    )
      .filter((s): s is string => Boolean(s && s.trim() !== ""))
      .map((content) => ({
        content,
        priority: "low" as const,
        essential: false,
        estimatedTokens: this.deps.llmProvider.countTokens(content),
      }));
    if (pluginBlocks.length > 0) {
      builder.addBlocks(pluginBlocks);
    }
    return builder.build();
  }

  /** Refresh the system prompt in context if dynamic blocks changed. */
  private refreshSystemPrompt(): void {
    const { prompt } = this.buildSystemPrompt();
    const current = this.deps.contextManager
      .getActiveHistory()
      .find((m) => m.role === "system");
    if (!current || current.content !== prompt) {
      this.deps.contextManager.updateSystemPrompt?.(prompt);
    }
  }

  private truncateToolOutput(
    output: string,
    budget: { history: number },
    currentTokens: number,
  ): string {
    const remainingBudget = budget.history - currentTokens;
    const maxCharsByBudget = Math.floor(remainingBudget * 0.5 * 2);
    const maxCharsByRatio = Math.floor(
      budget.history * TOOL_RESULT_MAX_TOKENS_RATIO * 2,
    );
    const maxChars = Math.min(
      maxCharsByBudget,
      maxCharsByRatio,
      TOOL_RESULT_ABSOLUTE_MAX_CHARS,
    );

    if (output.length <= maxChars) return output;

    const truncated = output.slice(0, maxChars);
    const removedChars = output.length - maxChars;
    return (
      truncated +
      `\n\n${t("tool.truncated", { tokens: Math.ceil(removedChars / 2) })}`
    );
  }

  private emitPhase(
    iteration: number,
    phase: AgentPhase,
    onPhase?: (phase: AgentPhase) => void,
  ): void {
    this.deps.pluginManager.runOnPhase?.({ iteration, logger: this.deps.logger }, phase);
    onPhase?.(phase);
  }

  async run(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: (meta: string) => void,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
  ): Promise<AgentResult> {
    this.setScope();
    const {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      logger,
      sessionManager,
    } = this.deps;

    if (sessionManager && !sessionManager.getActive()) {
      sessionManager.create();
      logger.debug(`Session started: ${sessionManager.getActive()}`);
    }

    if (
      !this.systemPromptAdded &&
      !contextManager.getActiveHistory().some((m) => m.role === "system")
    ) {
      const { prompt: systemPrompt, excluded } = this.buildSystemPrompt();
      contextManager.addMessage({ role: "system", content: systemPrompt });
      this.systemPromptAdded = true;
      if (sessionManager) {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "system",
          content: systemPrompt.slice(0, 2000),
        });
        if (excluded.length > 0) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "system",
            content: `[Excluded prompt blocks: ${excluded.length}]`,
          });
        }
      }
      pluginManager.runOnSessionStart({
        logger,
        sessionManager: sessionManager?.getActiveMeta(),
      });
    }

    contextManager.addMessage({ role: "user", content: input });

    if (sessionManager) {
      sessionManager.appendMessage({
        role: "user",
        content: input,
        timestamp: new Date().toISOString(),
      });
      sessionManager.appendLog({
        ts: new Date().toISOString(),
        type: "user",
        content: input,
      });
    }

    if (config.moe?.enabled) {
      return this.runWithMoE(input, onChunk, onMeta, onTool, onPhase);
    }

    return this.executeSingleAgentLoop(input, onChunk, onMeta, onTool, onPhase);
  }

  private async executeSingleAgentLoop(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: (meta: string) => void,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
  ): Promise<AgentResult> {
    const {
      config,
      llmProvider,
      toolExecutor,
      pluginManager,
      contextManager,
      hallucinationDetector,
      logger,
      sessionManager,
    } = this.deps;

    let iteration = 0;
    let lastText = "";
    let hallucinationRetries = 0;
    let lastToolSignature = "";
    const MAX_HALLUCINATION_RETRIES = 3;

    while (iteration < config.maxToolIterations) {
      iteration++;

      pluginManager.runOnBeforeThink({
        iteration,
        logger,
        lastUserMessage: input,
        contextManager,
        onMeta,
      });

      if (contextManager.needsCompaction()) {
        contextManager.compact();
        logger.debug("Context compacted");
        if (sessionManager) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "compaction",
            content: `regular compaction, iteration ${iteration}`,
            iteration,
          });
        }
      }

      const currentTokens = contextManager.getEstimatedTokens();
      const budget = contextManager.getBudget();
      if (currentTokens > budget.history) {
        contextManager.compact();
        logger.warn(
          `Context overflow (${currentTokens} > ${budget.history}), forced compaction`,
        );
        if (sessionManager) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "compaction",
            content: `forced compaction (${currentTokens} > ${budget.history}), iteration ${iteration}`,
            iteration,
            contextTokens: currentTokens,
            contextLimit: budget.history,
          });
        }
      }

      this.refreshSystemPrompt();
      const history = contextManager.getActiveHistory();

      const allTools = toolExecutor.getToolDefinitions(this.deps.toolTags);
      if (sessionManager) {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "tool_defs",
          toolCount: allTools.length,
          toolNames: allTools.map((t) => t.name),
          iteration,
        });
      }
      let textContent = "";
      let reasoningContent = "";
      const toolCalls: ToolCall[] = [];
      let sawToolCall = false;
      let emittedReasoning = false;

      this.emitPhase(iteration, "thinking", onPhase);
      try {
        for await (const chunk of llmProvider.chat(history, allTools as any)) {
          if (chunk.type === "text" && chunk.content) {
            if (emittedReasoning && !textContent) {
              onMeta?.("\n\n");
            }
            textContent += chunk.content;
            const textOut = pluginManager.runOnText(
              { iteration, logger },
              chunk.content,
            );
            onChunk?.(textOut);
          }
          if (chunk.type === "reasoning" && chunk.content) {
            reasoningContent += chunk.content;
            if (config.showReasoning) {
              const metaOut = pluginManager.runOnMeta(
                { iteration, logger },
                chunk.content,
              );
              if (metaOut) {
                onMeta?.(pc.dim(metaOut));
              }
              emittedReasoning = true;
            }
          }
          if (chunk.type === "tool_call" && chunk.toolCall) {
            sawToolCall = true;
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = JSON.parse(chunk.toolCall.arguments);
            } catch {
              parsedArgs = {};
            }
            toolCalls.push({
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: parsedArgs,
            });
          }
        }
      } catch (err: any) {
        logger.error(`LLM call failed: ${err.message}`);
        if (sessionManager) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "error",
            content: err.message,
          });
        }
        pluginManager.runOnError({ iteration, logger }, err);
        return {
          success: false,
          text: lastText,
          error: t("error.llm", { message: err.message }),
          iterationCount: iteration,
        };
      } finally {
        this.emitPhase(iteration, "done", onPhase);
      }

      let llmResponse: LLMResponse | null = null;
      if (sawToolCall) {
        llmResponse = { type: "tool_call", calls: toolCalls };
      } else if (textContent) {
        llmResponse = { type: "text", content: textContent };
      } else if (reasoningContent) {
        llmResponse = { type: "reasoning", content: reasoningContent };
      }
      pluginManager.runOnAfterThink({ iteration, logger }, llmResponse);

      if (this.deps.exitOnComplete && sawToolCall) {
        const signature = toolCalls
          .map((tc) => `${tc.name}:${JSON.stringify(tc.arguments)}`)
          .join("|");
        if (signature && signature === lastToolSignature) {
          logger.debug(
            "Exit-on-complete: repeated identical tool call, stopping",
          );
          break;
        }
        lastToolSignature = signature;
      }

      if (sessionManager) {
        if (reasoningContent) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "reasoning",
            content: reasoningContent,
            iteration,
          });
        }
        if (sawToolCall) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "assistant",
            content: textContent || "",
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
            iteration,
          });
        }
      }

      if (sawToolCall) {
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
        const summaries: string[] = [];
        for (const call of toolCalls) {
          this.setScope();
          const startTime = Date.now();
          pluginManager.runOnToolCall({
            toolName: call.name,
            args: call.arguments,
          });
          pluginManager.runOnToolStart(
            { iteration, logger },
            { id: call.id, name: call.name, arguments: call.arguments },
          );
          onTool?.({ type: "start", tool: call.name, args: call.arguments });
          if (sessionManager) {
            sessionManager.appendLog({
              ts: new Date().toISOString(),
              type: "tool_call",
              tool: call.name,
              tool_call_id: call.id,
              args: call.arguments,
              iteration,
            });
          }
          const result = await toolExecutor.execute(call);
          const duration = Date.now() - startTime;
          pluginManager.runOnToolEnd(
            { iteration, logger },
            { id: call.id, name: call.name, arguments: call.arguments },
            result,
            duration,
          );
          if (result.display) {
            onMeta?.("\n" + result.display + "\n");
          }
          const metaOut = pluginManager.runOnMeta(
            { iteration, logger },
            result.output,
          );
          onMeta?.("\n" + pc.dim(metaOut) + "\n");
          if (result.diff) {
            onMeta?.("\n" + result.diff + "\n");
          }
          onTool?.({
            type: "end",
            tool: call.name,
            args: call.arguments,
            duration,
            error: !result.success,
          });
          const currentTokens = contextManager.getEstimatedTokens();
          const budget = contextManager.getBudget();
          const truncatedOutput = this.truncateToolOutput(
            result.output,
            budget,
            currentTokens,
          );
          contextManager.addMessage({
            role: "tool",
            content: truncatedOutput,
            name: call.name,
            tool_call_id: call.id,
          });
          summaries.push(
            `[Tool: ${call.name} (${JSON.stringify(call.arguments)}) → ${truncatedOutput.slice(0, 200)}]`,
          );
          if (sessionManager && config.session.autoSave) {
            sessionManager.appendMessage({
              role: "tool",
              content: truncatedOutput.slice(0, 500),
              name: call.name,
              timestamp: new Date().toISOString(),
            });
            sessionManager.appendLog({
              ts: new Date().toISOString(),
              type: "tool_result",
              tool: call.name,
              tool_call_id: call.id,
              success: result.success,
              content: result.output.slice(0, 1000),
              diff: result.diff,
              duration,
              iteration,
            });
          }
          if (contextManager.needsCompaction()) {
            contextManager.compact();
            logger.debug("Context compacted after tool result");
          }
        }
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>${summaries.join("\n")}</system-summary>`,
        });
        continue;
      }

      const hallucinationResult = hallucinationDetector.validate(textContent);
      if (hallucinationResult.status === "block") {
        logger.warn(`Response blocked: ${hallucinationResult.reason}`);
        return {
          success: false,
          text: lastText,
          error: t("error.response_blocked", {
            reason: hallucinationResult.reason || "",
          }),
          iterationCount: iteration,
        };
      }
      if (hallucinationResult.status === "warn") {
        logger.warn(`Hallucination warning: ${hallucinationResult.reason}`);
        const warnPrefix = t("hall.uncertainty_prefix");
        if (onChunk) {
          onChunk(warnPrefix);
        }
        lastText = warnPrefix + lastText;
      }
      if (hallucinationResult.status === "retry") {
        if (this.deps.exitOnComplete) {
          logger.debug("Exit-on-complete: stopping on first response");
          break;
        }
        if (hallucinationRetries >= MAX_HALLUCINATION_RETRIES) {
          logger.warn(
            `Hallucination retries exhausted (${MAX_HALLUCINATION_RETRIES}), returning error`,
          );
          return {
            success: false,
            text: lastText,
            error: t("error.response_blocked", {
              reason: t("hall.max_retries_exhausted"),
            }),
            iterationCount: iteration,
          };
        }
        hallucinationRetries++;
        logger.warn(
          `Hallucination retry (${hallucinationRetries}/${MAX_HALLUCINATION_RETRIES}): ${hallucinationResult.reason}`,
        );
        if (textContent) {
          contextManager.addMessage({
            role: "assistant",
            content: textContent,
          });
        }
        contextManager.addMessage({
          role: "user",
          content: `<system-summary>[Retry context: ${hallucinationResult.reason}. Original task: "${input}". You must either call a needed tool or provide a substantive response. Empty replies are not allowed.]</system-summary>`,
        });
        continue;
      }

      if (textContent) {
        contextManager.addMessage({ role: "assistant", content: textContent });
        if (sessionManager && config.session.autoSave) {
          sessionManager.appendMessage({
            role: "assistant",
            content: textContent.slice(0, 500),
            timestamp: new Date().toISOString(),
          });
        }
      }
      if (sessionManager) {
        if (reasoningContent) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "reasoning",
            content: reasoningContent,
            iteration,
          });
        }
        if (textContent) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "assistant",
            content: textContent,
            iteration,
          });
        } else if (reasoningContent) {
          sessionManager.appendLog({
            ts: new Date().toISOString(),
            type: "assistant",
            content: reasoningContent,
            iteration,
          });
        }
      }

      lastText = textContent;

      if (!sawToolCall) {
        if (this.deps.finalAudit) {
          const audit = await this.deps.finalAudit();
          if (audit && !audit.passed) {
            logger.warn(`Final audit incomplete: ${audit.summary}`);
            const steps =
              audit.pendingSteps.slice(0, 5).join("; ") || "—";
            contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.audit_incomplete", {
                summary: audit.summary,
                steps,
              })}</system-summary>`,
            });
            if (sessionManager) {
              sessionManager.appendLog({
                ts: new Date().toISOString(),
                type: "audit",
                content: audit.summary,
                iteration,
              });
            }
            if (iteration >= config.maxToolIterations - 1) {
              break;
            }
            continue;
          }
        }
        break;
      }
    }

    const tokensUsed = contextManager.getEstimatedTokens();
    const budget = contextManager.getBudget();

    if (iteration >= config.maxToolIterations) {
      return {
        success: false,
        text: lastText,
        error: t("error.max_iters", { max: config.maxToolIterations }),
        iterationCount: iteration,
        contextUsed: tokensUsed,
        contextLimit: budget.history,
      };
    }

    return {
      success: true,
      text: lastText,
      iterationCount: iteration,
      contextUsed: tokensUsed,
      contextLimit: budget.history,
    };
  }

  private async runWithMoE(
    input: string,
    _onChunk?: (chunk: string) => void,
    onMeta?: (meta: string) => void,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: (phase: AgentPhase) => void,
  ): Promise<AgentResult> {
    const { config, llmProvider, logger } = this.deps;

    const orchestrator = new OrchestratorClient(
      {
        model: config.orchestrator.model,
        provider: config.orchestrator.provider,
      },
      llmProvider,
    );

    if (!orchestrator.isEnabled()) {
      logger.debug(
        "MoE enabled but no orchestrator model configured — falling back to single-agent",
      );
      return this.executeSingleAgentLoop(input, _onChunk, onMeta, onTool, onPhase);
    }

    onMeta?.("🤖 Planning with MoE mode...\n");
    this.emitPhase(0, "thinking", onPhase);
    const planResult = await orchestrator.plan(input);
    this.emitPhase(0, "done", onPhase);
    if ("error" in planResult) {
      logger.warn(
        `MoE plan failed: ${planResult.error} — falling back to single-agent`,
      );
      return this.executeSingleAgentLoop(input, _onChunk, onMeta, onTool);
    }

    const { plan } = planResult;
    onMeta?.(
      `📋 Plan created: "${plan.title}" (${plan.subtasks.length} subtasks)\n`,
    );

    const validation = validatePlan(plan, config);
    if (!validation.valid) {
      const applied = applyAutoFixes(plan, validation.autoFixes);
      const retry = validatePlan(applied, config);
      if (!retry.valid) {
        logger.warn(
          `MoE plan validation failed: ${retry.errors.join("; ")} — falling back to single-agent`,
        );
        onMeta?.(
          `⚠️ Plan validation failed. Falling back to single-agent mode.\n`,
        );
        return this.executeSingleAgentLoop(input, _onChunk, onMeta, onTool);
      }
      Object.assign(plan, applied);
      onMeta?.(`🔧 Auto-fixed ${validation.autoFixes.length} plan issues.\n`);
    }

    const moeDeps = {
      config,
      toolRegistry: (this.deps.toolExecutor as any).registry,
      toolExecutor: this.deps.toolExecutor,
      llmProvider,
      logger,
      baseDir: this.deps.baseDir,
    };

    const executor = new MoEExecutor(moeDeps);
    onMeta?.(`⚙️ Executing ${plan.subtasks.length} subtasks...\n`);
    const planResults = await executor.executePlan(plan);
    onMeta?.(
      `✅ Execution complete: ${planResults.results.filter((r) => r.success).length}/${planResults.results.length} succeeded\n`,
    );

    const verifier = new StepVerifier(this.deps.baseDir);
    const knownTags = [
      "file",
      "code",
      "shell",
      "research",
      "browser",
      "vision",
      "core",
    ];
    const verification = await verifier.verifyMoEManifest(
      plan,
      config,
      knownTags,
    );

    this.emitPhase(0, "thinking", onPhase);
    const verifyResult = await orchestrator.verifyAndMerge({
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
    this.emitPhase(0, "done", onPhase);

    const outputLines: string[] = [`## MoE Execution Results\n`];
    for (const r of planResults.results) {
      const icon = r.success ? "✅" : "❌";
      outputLines.push(
        `${icon} **${r.subtaskId}**: ${r.summary} (${r.durationMs}ms)`,
      );
    }
    outputLines.push("");
    if (verifyResult.type === "final") {
      outputLines.push(`**Result:** ${verifyResult.finalAnswer || "Complete"}`);
    } else {
      outputLines.push(
        `**Re-plan requested:** ${verifyResult.explanation || ""}`,
      );
    }

    const failedCount = planResults.results.filter((r) => !r.success).length;
    return {
      success: failedCount === 0 && verification.success,
      text: outputLines.join("\n"),
      iterationCount: planResults.results.length,
    };
  }

  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  setContext(
    messages: Array<{ role: string; content: string; name?: string }>,
  ): void {
    const { contextManager } = this.deps;
    contextManager.clear();
    const { prompt: systemPrompt } = this.buildSystemPrompt();
    contextManager.addMessage({ role: "system", content: systemPrompt });
    this.systemPromptAdded = true;
    for (const msg of messages) {
      if (msg.role === "system") continue;
      contextManager.addMessage({
        role: msg.role as Message["role"],
        content: msg.content,
        name: msg.name,
      });
    }
  }

  shutdown(): void {
    const { pluginManager, logger, sessionManager, contextManager } = this.deps;
    contextManager.onCompact = null;
    pluginManager.runOnSessionEnd({
      logger,
      sessionManager: sessionManager?.getActiveMeta(),
    });
  }
}
