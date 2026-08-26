import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { semverGt } from "../updater/checker";
import { Logger } from "../../logger/app-logger";

const logger = new Logger("warn", "plugins");

/**
 * Run a (possibly async) plugin hook with error isolation. Sync throws and
 * async rejections are both logged and swallowed — one broken plugin must
 * never crash the agent or other plugins.
 */
function safeInvoke(plugin: AgentPlugin, hookName: string, fn: () => unknown): unknown {
  try {
    const out = fn();
    if (out instanceof Promise) {
      // The promise rejects AFTER this try/catch has exited — attach a catch
      // now, otherwise isolation is broken by an unhandledRejection.
      out.catch((e: unknown) => {
        logger.warn(`plugin "${plugin.name}" ${hookName} rejected`, { error: String(e) });
      });
      return undefined;
    }
    return out;
  } catch (e) {
    logger.warn(`plugin "${plugin.name}" ${hookName} threw`, { error: String(e) });
    return undefined;
  }
}

export type RegisterResult =
  | { status: "registered" }
  | { status: "skipped_older"; existing: AgentPlugin }
  | { status: "duplicate" };

export interface PluginInfo {
  plugin: AgentPlugin;
  source?: "builtin" | "global" | "project";
}

export class PluginManager {
  private plugins: AgentPlugin[] = [];
  private hostBridge: HostBridge | null = null;

  /**
   * Register the host bridge (set once by the REPL). It is merged into every
   * hook context as `ctx.hostBridge` unless the caller already provided one.
   */
  setHostBridge(bridge: HostBridge): void {
    this.hostBridge = bridge;
  }

  /** Merge the host bridge into a hook context (caller-provided value wins). */
  private withHost<T>(ctx: T): T {
    if (!ctx || typeof ctx !== "object") return ctx;
    if (!this.hostBridge || (ctx as Record<string, unknown>).hostBridge !== undefined) {
      return ctx;
    }
    return { ...(ctx as object), hostBridge: this.hostBridge } as T;
  }

  /**
   * Register a plugin. Plugins with the same `name` are deduplicated — the
   * higher `version` wins (unversioned plugins count as "0.0.0"). The loser is
   * discarded; `skipped_older` lets the caller warn about the dropped copy.
   */
  register(plugin: AgentPlugin, source?: "builtin" | "global" | "project"): RegisterResult {
    if (source) plugin.source = source;
    const existing = this.plugins.find((p) => p.name === plugin.name);
    if (existing) {
      if (semverGt(plugin.version || "0.0.0", existing.version || "0.0.0")) {
        this.plugins = this.plugins.filter((p) => p.name !== plugin.name);
        this.plugins.push(plugin);
        this.sort();
        return { status: "registered" };
      }
      return { status: "skipped_older", existing };
    }
    this.plugins.push(plugin);
    this.sort();
    return { status: "registered" };
  }

  private sort(): void {
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  getAllPlugins(): AgentPlugin[] {
    return [...this.plugins];
  }

  /** Detailed plugin list (name, version, source) for REPL / CLI display. */
  getPluginInfos(): PluginInfo[] {
    return [...this.plugins].map((plugin) => ({ plugin, source: plugin.source }));
  }

  /** Find a registered plugin by name, or null. */
  getPlugin(name: string): AgentPlugin | null {
    return this.plugins.find((p) => p.name === name) ?? null;
  }

  runOnBuildPrompt(): (string | null)[] {
    return this.plugins.map(
      (p) => (safeInvoke(p, "onBuildPrompt", () => p.onBuildPrompt?.() ?? null) as string | null) ?? null,
    );
  }

  async runOnBeforeTool(rawCtx: any, call: ToolCall): Promise<boolean> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onBeforeTool) {
        try {
          const result = await plugin.onBeforeTool(ctx, call);
          if (result === false) return false;
        } catch (e) {
          logger.warn(`plugin "${plugin.name}" onBeforeTool failed`, { error: String(e) });
        }
      }
    }
    return true;
  }

  async runOnAfterTool(rawCtx: any, call: ToolCall, result: ToolResult): Promise<void> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onAfterTool) {
        try {
          await plugin.onAfterTool(ctx, call, result);
        } catch (e) {
          logger.warn(`plugin "${plugin.name}" onAfterTool failed`, { error: String(e) });
        }
      }
    }
  }

  async runOnError(rawCtx: any, error: Error): Promise<void> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onError) {
        try {
          await plugin.onError(ctx, error);
        } catch (e) {
          logger.warn(`plugin "${plugin.name}" onError failed`, { error: String(e) });
        }
      }
    }
  }

  runOnSessionStart(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onSessionStart) {
        safeInvoke(plugin, "onSessionStart", () => plugin.onSessionStart!(ctx));
      }
    }
  }

  runOnBeforeThink(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onBeforeThink) {
        safeInvoke(plugin, "onBeforeThink", () => plugin.onBeforeThink!(ctx));
      }
    }
  }

  runOnAfterThink(rawCtx: any, response: LLMResponse | null): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onAfterThink) {
        safeInvoke(plugin, "onAfterThink", () => plugin.onAfterThink!(ctx, response));
      }
    }
  }

  runOnSessionEnd(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onSessionEnd) {
        safeInvoke(plugin, "onSessionEnd", () => plugin.onSessionEnd!(ctx));
      }
    }
  }

  runOnToolCall(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolCall) {
        safeInvoke(plugin, "onToolCall", () => plugin.onToolCall!(ctx));
      }
    }
  }

  runOnPhase(rawCtx: any, phase: AgentPhase): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onPhase) {
        safeInvoke(plugin, "onPhase", () => plugin.onPhase!(ctx, phase));
      }
    }
  }

  runOnToolStart(rawCtx: any, call: ToolCall): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolStart) {
        safeInvoke(plugin, "onToolStart", () => plugin.onToolStart!(ctx, call));
      }
    }
  }

  runOnToolEnd(rawCtx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolEnd) {
        safeInvoke(plugin, "onToolEnd", () => plugin.onToolEnd!(ctx, call, result, durationMs));
      }
    }
  }

  /** Pipe a text chunk through plugin transforms; returns the (possibly replaced) chunk. */
  runOnText(rawCtx: any, chunk: string): string {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onText) {
        const out = safeInvoke(plugin, "onText", () => plugin.onText!(ctx, chunk));
        if (typeof out === "string") chunk = out;
      }
    }
    return chunk;
  }

  /** Pipe a meta chunk through plugin transforms; returns the (possibly replaced) chunk. */
  runOnMeta(rawCtx: any, chunk: string): string {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onMeta) {
        const out = safeInvoke(plugin, "onMeta", () => plugin.onMeta!(ctx, chunk));
        if (typeof out === "string") chunk = out;
      }
    }
    return chunk;
  }

  /** Dispatch a completed-run summary to all plugins (once per Agent.run()). */
  runOnTurnEnd(rawCtx: any, summary: TurnSummary): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onTurnEnd) {
        safeInvoke(plugin, "onTurnEnd", () => plugin.onTurnEnd!(ctx, summary));
      }
    }
  }
}
