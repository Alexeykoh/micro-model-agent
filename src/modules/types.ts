import type { PromptBlock, AgentPhase, LLMResponse } from "../core/types";
import type { ToolDefinition, ToolCall, ToolResult } from "../tools/types";

export interface AgentModule {
  name: string;
  getSystemPromptBlock?(): PromptBlock | null;
  getToolDefinitions?(): ToolDefinition[];
  getPlugin?(): AgentPlugin;
}

export interface HostBridgeSubmitOptions {
  /** Image data URLs attached to the message (`data:image/png;base64,...`). */
  images?: string[];
}

/**
 * Narrow API the host (REPL) exposes to plugins for driving the agent.
 * Registered via `PluginManager.setHostBridge()` and merged into every hook
 * context as `ctx.hostBridge`. Absent in single-run mode and tests without a host.
 */
export interface HostBridge {
  /** True while the agent is processing a turn. */
  isBusy(): boolean;
  /**
   * Submit a user message through the host's normal input path (same as typing
   * into the REPL). Rejects when the agent is busy. Resolves when the turn ends.
   */
  submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown>;
  /** Interrupt the current run (no-op when idle). */
  interrupt(): void;
}

/** Summary of a completed agent run, passed to `AgentPlugin.onTurnEnd`. */
export interface TurnSummary {
  success: boolean;
  durationMs: number;
  textLength: number;
  toolCalls: number;
  interrupted?: boolean;
}

export interface AgentPlugin {
  name: string;
  priority?: number;
  isBuiltin?: boolean;
  /** Semver version of the plugin. Used for dedup (higher wins) and `mma plugins list`. */
  version?: string;
  /** Minimum MMA version (semver) required to run this plugin. Loader skips incompatible ones. */
  minMmaVersion?: string;
  /** Where the plugin came from: "builtin" | "global" | "project". Set by loader/registration. */
  source?: "builtin" | "global" | "project";
  /** Add a prompt block to the system prompt (runs once at build time). */
  onBuildPrompt?(): string | null;
  /**
   * Return `false` to block a tool call before it executes, or a string to
   * block with an explicit reason shown to the model.
   */
  onBeforeTool?(ctx: any, call: ToolCall): boolean | string | Promise<boolean | string>;
  /** Runs after a tool executes; may mutate `result.output`. */
  onAfterTool?(ctx: any, call: ToolCall, result: ToolResult): void | Promise<void>;
  /** Before each LLM call. */
  onBeforeThink?(ctx: any): void;
  /** After the LLM returns; receives the parsed response. */
  onAfterThink?(ctx: any, response: LLMResponse | null): void;
  /** When the LLM returns a tool call. */
  onToolCall?(ctx: any): void;
  onError?(ctx: any, error: Error): void;
  onSessionStart?(ctx: any): void;
  onSessionEnd?(ctx: any): void;
  /** Thinking spinner lifecycle: 'thinking' | 'done'. */
  onPhase?(ctx: any, phase: AgentPhase): void;
  /** Tool card opened (before execution). */
  onToolStart?(ctx: any, call: ToolCall): void;
  /** Tool card closed (after execution, with duration). */
  onToolEnd?(ctx: any, call: ToolCall, result: ToolResult, durationMs: number): void;
  /** Transform/filter streamed model text; return a string to replace, undefined to pass through. */
  onText?(ctx: any, chunk: string): string | void;
  /** Transform/filter streamed meta (reasoning + tool output); return a string to replace, undefined to pass through. */
  onMeta?(ctx: any, chunk: string): string | void;
  /** Called once when an agent `run()` completes (final answer, error or interrupt). */
  onTurnEnd?(ctx: any, summary: TurnSummary): void;
}
