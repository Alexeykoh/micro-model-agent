import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { semverGt } from "../updater/checker";

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
    return this.plugins.map((p) => {
      try {
        return p.onBuildPrompt?.() ?? null;
      } catch {
        return null;
      }
    });
  }

  async runOnBeforeTool(rawCtx: any, call: ToolCall): Promise<boolean> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onBeforeTool) {
        try {
          const result = await plugin.onBeforeTool(ctx, call);
          if (result === false) return false;
        } catch {
          /* error isolation */
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
        } catch {
          /* error isolation */
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
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnSessionStart(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onSessionStart) {
        try {
          plugin.onSessionStart(ctx);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnBeforeThink(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onBeforeThink) {
        try {
          plugin.onBeforeThink(ctx);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnAfterThink(rawCtx: any, response: LLMResponse | null): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onAfterThink) {
        try {
          plugin.onAfterThink(ctx, response);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnSessionEnd(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onSessionEnd) {
        try {
          plugin.onSessionEnd(ctx);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnToolCall(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolCall) {
        try {
          plugin.onToolCall(ctx);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnPhase(rawCtx: any, phase: AgentPhase): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onPhase) {
        try {
          plugin.onPhase(ctx, phase);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnToolStart(rawCtx: any, call: ToolCall): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolStart) {
        try {
          plugin.onToolStart(ctx, call);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  runOnToolEnd(rawCtx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolEnd) {
        try {
          plugin.onToolEnd(ctx, call, result, durationMs);
        } catch {
          /* error isolation */
        }
      }
    }
  }

  /** Pipe a text chunk through plugin transforms; returns the (possibly replaced) chunk. */
  runOnText(rawCtx: any, chunk: string): string {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onText) {
        try {
          const out = plugin.onText(ctx, chunk);
          if (typeof out === "string") chunk = out;
        } catch {
          /* error isolation */
        }
      }
    }
    return chunk;
  }

  /** Pipe a meta chunk through plugin transforms; returns the (possibly replaced) chunk. */
  runOnMeta(rawCtx: any, chunk: string): string {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onMeta) {
        try {
          const out = plugin.onMeta(ctx, chunk);
          if (typeof out === "string") chunk = out;
        } catch {
          /* error isolation */
        }
      }
    }
    return chunk;
  }

  /** Dispatch a completed-run summary to all plugins (once per Agent.run()). */
  runOnTurnEnd(rawCtx: any, summary: TurnSummary): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onTurnEnd) {
        try {
          plugin.onTurnEnd(ctx, summary);
        } catch {
          /* error isolation */
        }
      }
    }
  }
}
