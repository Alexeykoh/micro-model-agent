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
  /**
   * Deterministic read-only tool: the executor memoizes successful results
   * (keyed by session + name + arguments, 120s TTL) and serves repeats
   * without re-running the handler. Mark only tools that cannot mutate
   * anything and whose output is stable while no mutating tool runs —
   * any non-cacheable execution wipes the memo. Model-facing behavior is
   * unchanged (the stored result goes through the same post-processing).
   */
  cacheable?: boolean;
  /**
   * The tool manages its own memo entries via `ctx.toolExecutor`
   * (`memoGet`/`memoSet`/`memoInvalidate`) because cacheability depends on
   * the arguments (e.g. bash: `npm view` is memoizable, `npm publish` is
   * not). The executor skips auto-invalidation for such tools — the tool
   * itself must invalidate on anything that may mutate.
   */
  manualMemo?: boolean;
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
  /**
   * Resolved capabilities of the ACTIVE model (preset + live probe + config
   * override). Tools that depend on model abilities (browser vision, image
   * attachment) must read this instead of guessing from the model name.
   */
  capabilities?: import("../config/types").ModelCapabilities;
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
   * Strict tool allowlist for the current turn/session. When set, ONLY these
   * tool names are exposed to the LLM and executable — `alwaysOn` and tags do
   * NOT bypass it. Used by onboarding so the agent cannot touch the repo.
   * Undefined = normal tag-based selection.
   */
  toolAllowlist?: string[];
  /**
   * When set, write_file/edit_file may only target these absolute paths
   * (case-insensitive). Used by onboarding `init` to restrict writes to
   * AGENTS.md. Undefined = no restriction.
   */
  writePathAllowlist?: string[];
  /**
   * Shared onboarding state. Set by the `meet_done` sentinel tool and read by
   * the REPL to leave meet mode. Carries the active guide block so the REPL
   * can remove it on exit. Undefined outside an onboarding session.
   */
  onboarding?: { done: boolean; block?: import("../core/types").PromptBlock };
  /**
   * Optional cleanup callback invoked by the executor when the tool times
   * out or is aborted. Used by subagent to restore the parent's scope even
   * when the agent's `finally` block never runs (abandoned promise).
   */
  cleanup?: () => void;
  /**
   * Test seam — factory for the sub-agent instance (Bun module mocks are
   * process-global, so vi.mock cannot be used for the Agent class).
   */
  agentFactory?: (deps: unknown) => {
    run(task: string): Promise<import("../core/types").AgentResult>;
  };
  /**
   * Session manager — exposes active session metadata to tools.
   * Added for session_info tool; kept minimal to avoid circular deps.
   */
  sessionManager?: {
    getActiveMeta(): {
      id: string;
      name: string;
      model?: string;
      contextWindow?: number;
      messageCount: number;
      createdAt: string;
      updatedAt: string;
    } | null;
  };
  /**
   * Terminal-agnostic prompt surface for interactive tools. The REPL installs
   * one that takes over the terminal for the duration of a question; headless
   * runs leave it undefined so tools fall back to the legacy readline path.
   */
  promptIO?: import("./prompt-io").PromptIO;
}

export interface ToolResult {
  success: boolean;
  output: string;
  toolCallId?: string;
  display?: string;
  diff?: string;
  /**
   * Изображения, произведённые тулом (например, browser screenshot или
   * будущий рендер графика). Доставляются модели отдельным user-сообщением
   * (см. `queueToolImages`), а НЕ строкой base64 внутри `output`: в
   * `role:"tool"` content по контракту OpenAI/Jinja — только текст.
   */
  images?: import("../llm/provider").ImageUrlPart[];
  /**
   * True when a plugin's `onBeforeTool` refused the call before the tool ran.
   * Such a result is `success:false`, but it is NOT evidence the action is
   * broken — the plugin may be guard-railing ordering, scope, or security.
   * Callers must exclude blocked calls from failure/retry accounting
   * (consecutive-failure recovery, "already tried & failed" compaction memory,
   * repeated-tool-failure rules); otherwise a transient guard (or a guard bug)
   * poisons the agent into never retrying a correct action.
   */
  blocked?: boolean;
  /** Absolute path of a persisted artifact (subagent result_mode:"file"). */
  artifactPath?: string;
  /** Token usage of the sub-agent run (MoE cost attribution per expert_tag). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
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
