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

  logCompaction(
    content: string,
    iteration: number,
    contextTokens?: number,
    contextLimit?: number,
  ): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: "compaction",
      content,
      iteration,
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextLimit !== undefined ? { contextLimit } : {}),
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
