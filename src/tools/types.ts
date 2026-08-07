export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags?: string[];
  /** Interactive tools wait for user input and are exempt from the execution timeout. */
  interactive?: boolean;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
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
}

export interface ToolResult {
  success: boolean;
  output: string;
  toolCallId?: string;
  display?: string;
  diff?: string;
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
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | Promise<boolean>;
  onAfterTool?(
    ctx: ToolContext,
    call: ToolCall,
    result: ToolResult,
  ): void | Promise<void>;
}

export interface PluginManager {
  getAllPlugins(): PluginHook[];
}
