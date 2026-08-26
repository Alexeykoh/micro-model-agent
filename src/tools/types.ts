export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Emoji icon shown in the tool header (e.g. 📝, 🔍, 💻). Falls back to
   *  the hardcoded marker in `toolMarker()` when not set. */
  icon?: string;
  tags?: string[];
  /**
   * Tools that survive any tag-based filtering (getAllForLLM/getByTags/
   * filterToolsByTags). Structural tools (plan/todo/verify/project_map/
   * lsp_check/enable_tools) are alwaysOn so plan enforcement and LSP checks
   * keep working even when the LLM tool set is narrowed.
   */
  alwaysOn?: boolean;
  /** Interactive tools wait for user input and are exempt from the execution timeout. */
  interactive?: boolean;
  /**
   * Per-tool execution timeout override in ms. Defaults to the executor's
   * TOOL_EXECUTION_TIMEOUT_MS (60s). Used by tools that make multiple LLM
   * calls (e.g. chunk_query) and need a longer budget on slow providers.
   */
  timeoutMs?: number;
  /**
   * The tool bounds its own output size (line limits, entry caps, tail caps).
   * Budget-based truncation in the agent loop must never apply to such tools —
   * near-full context was cutting read_file results to ~2K chars, making the
   * model believe files were truncated and re-read them forever.
   */
  boundedOutput?: boolean;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolScope {
  allowed_files: string[];
  read_only_files: string[];
}

export interface ToolContext {
  config: import("../config/types").AppConfig;
  baseDir: string;
  logger: import("../logger/app-logger").Logger;
  scope?: ToolScope;
  llmProvider?: import("../llm/provider").LLMProvider;
  toolExecutor?: import("./executor").ToolExecutor;
  contextManager?: import("../modules/context/manager").ContextManager;
  sessionHistory?: {
    append(type: string, content: unknown): Promise<void>;
  };
  /**
   * Append a structured entry to the session execution log (session.jsonl).
   * Used by execution/module to record plan progress for post-mortem analysis.
   */
  sessionLog?: {
    plan(event: string, detail: string, iteration?: number): void;
  };
  /**
   * One-shot headless mode: interactive tools (question/approve) fail fast
   * instead of blocking on stdin, and the agent exits on the first final answer.
   */
  exitOnComplete?: boolean;
  /**
   * Current recursion depth for sub-agents
   */
  recursionDepth?: number;
  /**
   * Session ID for audit logging
   */
  sessionId?: string;
  /**
   * File operations counter for rate limiting
   */
  fileOperationsCount?: number;
  /**
   * Session context for isolation
   */
  sessionContext?: import("../modules/security/session-isolation").SessionContext;
  /**
   * Id of the tool call currently being executed. Set by the executor so
   * long-running tools (e.g. bash) can be killed when the execution timeout
   * fires.
   */
  activeCallId?: string;
  /**
   * Shared mutable array of tool tags enabled on demand via the
   * `enable_tools` tool. The agent loop re-reads it every iteration to
   * recompute the LLM-visible tool set. When on-demand enable is disabled
   * this stays empty and getAllForLLM returns every tool (legacy mode).
   */
  activeToolTags?: string[];
  /**
   * Optional cleanup callback invoked by the executor when the tool times
   * out or is aborted. Used by subagent to restore the parent's scope even
   * when the agent's `finally` block never runs (abandoned promise).
   */
  cleanup?: () => void;
}

export interface ToolResult {
  success: boolean;
  output: string;
  toolCallId?: string;
  display?: string;
  diff?: string;
  /** Absolute path of a persisted artifact (subagent result_mode:"file"). */
  artifactPath?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PluginHook {
  name?: string;
  priority?: number;
  isBuiltin?: boolean;
  /**
   * Return `false` to block the tool, a string to block with an explicit
   * reason (shown to the model), or `true` to allow.
   */
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | string | Promise<boolean | string>;
  onAfterTool?(ctx: ToolContext, call: ToolCall, result: ToolResult): void | Promise<void>;
}

export interface PluginManager {
  getAllPlugins(): PluginHook[];
}
