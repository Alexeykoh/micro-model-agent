import type { SessionManager } from "../modules/session/manager";
import type { ToolCall } from "./types";
import type { Logger } from "../logger/app-logger";
import { setAuditSessionDir } from "../modules/security/audit-log";

/**
 * Thin wrapper around SessionManager that eliminates repetitive
 * `if (sessionManager)` + `new Date().toISOString()` boilerplate
 * from the agent loop.
 *
 * When constructed, it configures the app logger and audit log to write into
 * the session directory (instead of global ~/.mma/logs/).
 */
export class SessionLogger {
  private logger: Logger | undefined;

  constructor(
    private session: SessionManager | undefined,
    logger?: Logger,
  ) {
    this.logger = logger;
    this.bindSessionDir();
  }

  private bindSessionDir(): void {
    const meta = this.session?.getActiveMeta();
    if (!meta) return;

    const dir = this.session!.getSessionDirectory(meta.id);

    if (this.logger) {
      this.logger.setSessionDir(dir);
      this.logger.initSessionLog(meta.id);
    }

    setAuditSessionDir(dir);
  }

  get active(): boolean {
    return !!this.session?.getActive();
  }

  logSystem(content: string): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "system",
      content,
    });
  }

  logUser(content: string): void {
    this.session?.appendMessage({
      role: "user",
      content,
      timestamp: new Date().toISOString(),
    });
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "user",
      content,
    });
  }

  logAssistant(
    content: string,
    reasoning?: string,
    toolCalls?: ToolCall[],
    iteration?: number,
  ): void {
    if (reasoning) {
      this.session?.appendLog({
        ts: new Date().toISOString(),
        type: "reasoning",
        content: reasoning,
        iteration,
      });
    }
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "assistant",
      content,
      ...(toolCalls
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
            })),
          }
        : {}),
      iteration,
    });
  }

  saveAssistantMessage(content: string): void {
    this.session?.appendMessage({
      role: "assistant",
      content: content.slice(0, 500),
      timestamp: new Date().toISOString(),
    });
  }

  logToolDefs(toolCount: number, toolNames: string[], iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "tool_defs",
      toolCount,
      toolNames,
      iteration,
    });
  }

  logToolCall(call: ToolCall, iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "tool_call",
      tool: call.name,
      tool_call_id: call.id,
      args: call.arguments,
      iteration,
    });
  }

  logToolResult(
    call: ToolCall,
    result: { success: boolean; output: string; diff?: string },
    duration: number,
    iteration: number,
  ): void {
    this.session?.appendMessage({
      role: "tool",
      content: result.output.slice(0, 500),
      name: call.name,
      timestamp: new Date().toISOString(),
    });
    this.session?.appendLog({
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

  logCompaction(info: {
    reason: string;
    iteration: number;
    tokensBefore?: number;
    tokensAfter?: number;
    qualityBefore?: number;
    qualityAfter?: number;
    messagesBefore?: number;
    messagesAfter?: number;
    removedTurns?: number;
    keptTurns?: number;
    summary?: string;
  }): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "compaction",
      content: `${info.reason}, iteration ${info.iteration}`,
      iteration: info.iteration,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      tokensAfter: info.tokensAfter,
      qualityBefore: info.qualityBefore,
      qualityAfter: info.qualityAfter,
      messagesBefore: info.messagesBefore,
      messagesAfter: info.messagesAfter,
      removedTurns: info.removedTurns,
      keptTurns: info.keptTurns,
      summary: info.summary,
    });
  }

  logContext(info: {
    kind: "start" | "iteration";
    iteration: number;
    window?: number;
    systemBudget?: number;
    reserveBudget?: number;
    historyBudget?: number;
    systemTokens?: number;
    toolTokens?: number;
    tokens: number;
    quality: number;
    messageCount: number;
    compactionCount: number;
    iterationsSinceCompaction: number;
    blocks?: Array<{
      label: string;
      priority: string;
      tokens: number;
      included: boolean;
    }>;
  }): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "context",
      content:
        info.kind === "start"
          ? "context snapshot at session start"
          : `context at iteration ${info.iteration}`,
      iteration: info.iteration,
      window: info.window,
      systemBudget: info.systemBudget,
      reserveBudget: info.reserveBudget,
      historyBudget: info.historyBudget,
      systemTokens: info.systemTokens,
      toolTokens: info.toolTokens,
      contextTokens: info.tokens,
      quality: info.quality,
      messageCount: info.messageCount,
      compactionCount: info.compactionCount,
      iterationsSinceCompaction: info.iterationsSinceCompaction,
      blocks: info.blocks,
    });
  }

  logLlmUsage(
    iteration: number,
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      source: "api" | "estimate";
      durationMs: number;
    },
  ): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "llm_usage",
      iteration,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      source: usage.source,
      durationMs: usage.durationMs,
    });
  }

  logError(message: string): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "error",
      content: message,
    });
  }

  logAudit(summary: string, iteration: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "audit",
      content: summary,
      iteration,
    });
  }

  logPlan(event: string, detail: string, iteration?: number): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "plan",
      content: detail,
      tool: event,
      ...(iteration !== undefined ? { iteration } : {}),
    });
  }
}
