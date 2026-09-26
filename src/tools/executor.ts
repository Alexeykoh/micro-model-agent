import type { ToolContext, ToolCall, ToolResult, PluginManager } from "./types";
import type { ToolRegistry } from "./registry";
import { killByCallId } from "../modules/processes/runner";
import { t } from "../i18n/index";

const TOOL_EXECUTION_TIMEOUT_MS = 60000;

/** Memo entry lifetime — bounds staleness from out-of-band changes. */
const MEMO_TTL_MS = 120000;
const MEMO_MAX_ENTRIES = 100;

/** Stable stringify: sorted keys, so arg order never splits the memo key. */
function stableArgsKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableArgsKey);
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, stableArgsKey((value as Record<string, unknown>)[k])]);
    return Object.fromEntries(entries);
  }
  return value;
}

export class ToolExecutor {
  private registry: ToolRegistry;
  private ctx: ToolContext;
  private pluginManager: PluginManager;
  /**
   * Session-scoped memo of deterministic read-only results
   * (`ToolDefinition.cacheable` + manual entries from `manualMemo` tools
   * such as bash). Key: `sessionId::name::stableArgs`.
   */
  private memo = new Map<string, { result: ToolResult; at: number }>();

  constructor(registry: ToolRegistry, ctx: ToolContext, pluginManager: PluginManager) {
    this.registry = registry;
    this.ctx = ctx;
    this.pluginManager = pluginManager;
  }

  /**
   * Execute a tool by name with plain arguments (no call id, no timeout
   * wiring). Used internally — e.g. bash redirects a mistaken tool-call-as-
   * command into the real tool. Runs through the same registry and plugin
   * hooks as a normal call.
   *
   * **Reentrancy warning:** swaps `this.ctx` temporarily (line 30-39). Safe
   * for sequential callers but NOT for concurrent calls on the same executor
   * instance — they would race on the ctx swap. Today all callers are
   * sequential (bash redirect, single subagent tool); keep it that way.
   */
  async executeByName(
    name: string,
    args: Record<string, unknown>,
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const prevCtx = this.ctx;
    if (ctx) this.ctx = ctx;
    try {
      return await this.execute({
        id: `redirect_${Date.now()}`,
        name,
        arguments: args,
      });
    } finally {
      this.ctx = prevCtx;
    }
  }

  /** Whether a tool with this name is registered (used before redirects). */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  private memoKey(name: string, args: Record<string, unknown>): string {
    return `${this.ctx.sessionId ?? ""}::${name}::${JSON.stringify(stableArgsKey(args))}`;
  }

  /**
   * Memo read for `manualMemo` tools (bash). Returns a detached copy —
   * callers must set `toolCallId` themselves.
   */
  memoGet(name: string, args: Record<string, unknown>): ToolResult | undefined {
    const hit = this.memo.get(this.memoKey(name, args));
    if (!hit) return undefined;
    if (Date.now() - hit.at > MEMO_TTL_MS) {
      this.memo.delete(this.memoKey(name, args));
      return undefined;
    }
    return { ...hit.result };
  }

  /** Memo write for `manualMemo` tools. Stores a detached copy. */
  memoSet(name: string, args: Record<string, unknown>, result: ToolResult): void {
    const key = this.memoKey(name, args);
    if (!this.memo.has(key) && this.memo.size >= MEMO_MAX_ENTRIES) {
      const oldest = this.memo.keys().next();
      if (!oldest.done) this.memo.delete(oldest.value);
    }
    this.memo.set(key, { result: { ...result }, at: Date.now() });
  }

  /** Wipe the memo — called after anything that may have mutated state. */
  memoInvalidate(): void {
    this.memo.clear();
  }

  /**
   * Allowlisted tool names as a set, or `null` when unrestricted.
   * `undefined` means no restriction; `[]` means block everything.
   */
  private allowedNames(): Set<string> | null {
    const allow = this.ctx.toolAllowlist;
    return allow ? new Set(allow) : null;
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const allow = this.allowedNames();
    if (allow && !allow.has(call.name)) {
      return {
        success: false,
        output: t("tool.not_allowed", { name: call.name }),
        toolCallId: call.id,
      };
    }

    const tool = this.registry.get(call.name);
    if (!tool) {
      return {
        success: false,
        output: t("tool.unknown", { name: call.name }),
        toolCallId: call.id,
      };
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onBeforeTool) {
        try {
          const proceed = await plugin.onBeforeTool(this.ctx, call);
          if (proceed === false || typeof proceed === "string") {
            const pluginName =
              (plugin as { name?: string }).name || plugin.constructor?.name || "unknown";
            const reason = typeof proceed === "string" ? proceed : undefined;
            return {
              success: false,
              blocked: true,
              output: reason
                ? t("tool.blocked_reason", { plugin: pluginName, reason })
                : t("tool.blocked", { plugin: pluginName }),
              toolCallId: call.id,
            };
          }
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onBeforeTool error: ${e.message}`);
        }
      }
    }

    let result: ToolResult;
    // Memoized repeat of a deterministic read (ToolDefinition.cacheable):
    // skip the handler; the shared tail below (post-tool plugins, logging)
    // still runs so a memo hit is indistinguishable from a fresh run.
    const memoHit = tool.cacheable ? this.memoGet(call.name, call.arguments) : undefined;
    try {
      this.ctx.activeCallId = call.id;
      if (tool.interactive) {
        // Interactive tools wait for user input — no timeout.
        result = memoHit ?? (await tool.handler(this.ctx, call.arguments));
      } else {
        const timeoutMs = tool.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
        const failFast = (message: string) => {
          // Kill any long-running child process registered for this call.
          killByCallId(call.id);
          // Run tool-specific cleanup (e.g. subagent scope restore) before
          // rejecting so shared state is restored even on abandonment.
          const cleanup = this.ctx.cleanup;
          if (cleanup) {
            cleanup();
            // Clear only if no newer call has replaced it meanwhile.
            if (this.ctx.cleanup === cleanup) this.ctx.cleanup = undefined;
          }
          return new Error(message);
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const timeoutPromise = new Promise<ToolResult>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              failFast(
                t("tool.timeout", {
                  name: call.name,
                  seconds: Math.round(timeoutMs / 1000),
                }),
              ),
            );
          }, timeoutMs);
        });
        const racePromises: Promise<ToolResult>[] = [
          memoHit ? Promise.resolve(memoHit) : tool.handler(this.ctx, call.arguments),
          timeoutPromise,
        ];
        if (signal) {
          const abortPromise = new Promise<ToolResult>((_, reject) => {
            onAbort = () => reject(failFast(t("tool.aborted", { name: call.name })));
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
          racePromises.push(abortPromise);
        }
        try {
          result = await Promise.race(racePromises);
        } finally {
          // Stop the timer and detach the abort listener once settled so they
          // never fire against a DIFFERENT call's context/cleanup later.
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          // Losing promises have no consumer after Promise.race settled
          // (their kill/cleanup effects were already applied in failFast).
          // Log the rejection, then detach it so it never surfaces as an
          // unhandled rejection.
          for (const p of racePromises.slice(1)) {
            p.catch((e: Error) => {
              this.ctx.logger.debug(
                `Tool ${call.name}: discarded race loser: ${e.message}`,
              );
            });
          }
        }
      }
      result.toolCallId = call.id;
    } catch (e: any) {
      result = {
        success: false,
        output: `${t("error.prefix")}${e.message}`,
        toolCallId: call.id,
      };
    }

    if (!memoHit) {
      // Successful deterministic reads are memoized; anything else that ran
      // may have mutated state (even a failed command can half-apply), so it
      // wipes the memo. `manualMemo` tools (bash) manage their own entries.
      if (tool.cacheable && result.success) {
        this.memoSet(call.name, call.arguments, result);
      } else if (!tool.cacheable && !tool.manualMemo) {
        this.memoInvalidate();
      }
    }

    // After an abort the tool's work is discarded (the agent loop breaks
    // without rendering or logging it), so skip the slow post-tool plugins
    // (LSP checks, lint, tsc) entirely. When the abort lands mid-plugin the
    // signal in the hook context lets the plugin kill its child processes.
    if (signal?.aborted) {
      this.ctx.logger.debug(`Tool ${call.name}: abort, skipping onAfterTool plugins`);
    } else {
      const pluginCtx = signal ? { ...this.ctx, signal } : this.ctx;
      for (const plugin of this.pluginManager.getAllPlugins()) {
        if (plugin.onAfterTool) {
          try {
            await plugin.onAfterTool(pluginCtx, call, result);
          } catch (e: any) {
            this.ctx.logger.warn(`Plugin onAfterTool error: ${e.message}`);
          }
        }
      }
    }

    this.ctx.logger.logToolCall(
      call.name,
      JSON.stringify(call.arguments)?.slice(0, 200) ?? "",
      result.success ? "OK" : `FAIL: ${result.output?.slice(0, 200)}`,
    );
    this.ctx.logger.logToolOutput(call.name, result.output ?? "", result.success ? 0 : 1);
    this.ctx.logger.debug(`Tool ${call.name}: ${result.success ? "OK" : "FAIL"}`);
    return result;
  }

  getToolDefinitions(tags?: string[]): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    boundedOutput?: boolean;
  }> {
    const allow = this.allowedNames();
    if (allow) {
      return this.registry
        .getAll()
        .filter((t) => allow.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          boundedOutput: t.boundedOutput,
        }));
    }
    return this.registry.getAllForLLM(tags);
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  setScope(scope: import("./types").ToolScope | undefined): void {
    this.ctx.scope = scope;
  }

  /** Current shared-executor scope (used for compare-and-restore by subagents). */
  getScope(): import("./types").ToolScope | undefined {
    return this.ctx.scope;
  }

  setPromptIO(io?: import("./prompt-io").PromptIO): void {
    this.ctx.promptIO = io;
  }

  getRecursionDepth(): number {
    return this.ctx.recursionDepth ?? 0;
  }

  setRecursionDepth(depth: number): void {
    this.ctx.recursionDepth = depth;
  }

  updateProvider(provider: import("../llm/provider").LLMProvider): void {
    this.ctx.llmProvider = provider;
  }
}
