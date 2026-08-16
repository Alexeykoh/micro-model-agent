import type { AgentPlugin } from '../types'
import type { ToolCall, ToolResult } from '../../tools/types'
import type { AgentPhase, LLMResponse } from '../../core/types'
import { semverGt } from '../updater/checker'

export type RegisterResult =
  | { status: 'registered' }
  | { status: 'skipped_older'; existing: AgentPlugin }
  | { status: 'duplicate' }

export interface PluginInfo {
  plugin: AgentPlugin
  source?: 'builtin' | 'global' | 'project'
}

export class PluginManager {
  private plugins: AgentPlugin[] = []

  /**
   * Register a plugin. Plugins with the same `name` are deduplicated — the
   * higher `version` wins (unversioned plugins count as "0.0.0"). The loser is
   * discarded; `skipped_older` lets the caller warn about the dropped copy.
   */
  register(plugin: AgentPlugin, source?: 'builtin' | 'global' | 'project'): RegisterResult {
    if (source) plugin.source = source
    const existing = this.plugins.find((p) => p.name === plugin.name)
    if (existing) {
      if (semverGt(plugin.version || '0.0.0', existing.version || '0.0.0')) {
        this.plugins = this.plugins.filter((p) => p.name !== plugin.name)
        this.plugins.push(plugin)
        this.sort()
        return { status: 'registered' }
      }
      return { status: 'skipped_older', existing }
    }
    this.plugins.push(plugin)
    this.sort()
    return { status: 'registered' }
  }

  private sort(): void {
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  }

  getAllPlugins(): AgentPlugin[] {
    return [...this.plugins]
  }

  /** Detailed plugin list (name, version, source) for REPL / CLI display. */
  getPluginInfos(): PluginInfo[] {
    return [...this.plugins].map((plugin) => ({ plugin, source: plugin.source }))
  }

  /** Find a registered plugin by name, or null. */
  getPlugin(name: string): AgentPlugin | null {
    return this.plugins.find((p) => p.name === name) ?? null
  }

  runOnBuildPrompt(): (string | null)[] {
    return this.plugins.map(p => {
      try { return p.onBuildPrompt?.() ?? null }
      catch { return null }
    })
  }

  async runOnBeforeTool(ctx: any, call: ToolCall): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (plugin.onBeforeTool) {
        try {
          const result = await plugin.onBeforeTool(ctx, call)
          if (result === false) return false
        } catch { /* error isolation */ }
      }
    }
    return true
  }

  async runOnAfterTool(ctx: any, call: ToolCall, result: ToolResult): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onAfterTool) {
        try { await plugin.onAfterTool(ctx, call, result) }
        catch { /* error isolation */ }
      }
    }
  }

  async runOnError(ctx: any, error: Error): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onError) {
        try { await plugin.onError(ctx, error) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnSessionStart(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onSessionStart) {
        try { plugin.onSessionStart(ctx) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnBeforeThink(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onBeforeThink) {
        try { plugin.onBeforeThink(ctx) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnAfterThink(ctx: any, response: LLMResponse | null): void {
    for (const plugin of this.plugins) {
      if (plugin.onAfterThink) {
        try { plugin.onAfterThink(ctx, response) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnSessionEnd(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onSessionEnd) {
        try { plugin.onSessionEnd(ctx) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnToolCall(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onToolCall) {
        try { plugin.onToolCall(ctx) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnPhase(ctx: any, phase: AgentPhase): void {
    for (const plugin of this.plugins) {
      if (plugin.onPhase) {
        try { plugin.onPhase(ctx, phase) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnToolStart(ctx: any, call: ToolCall): void {
    for (const plugin of this.plugins) {
      if (plugin.onToolStart) {
        try { plugin.onToolStart(ctx, call) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnToolEnd(ctx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    for (const plugin of this.plugins) {
      if (plugin.onToolEnd) {
        try { plugin.onToolEnd(ctx, call, result, durationMs) }
        catch { /* error isolation */ }
      }
    }
  }

  /** Pipe a text chunk through plugin transforms; returns the (possibly replaced) chunk. */
  runOnText(ctx: any, chunk: string): string {
    for (const plugin of this.plugins) {
      if (plugin.onText) {
        try {
          const out = plugin.onText(ctx, chunk)
          if (typeof out === 'string') chunk = out
        } catch { /* error isolation */ }
      }
    }
    return chunk
  }

  /** Pipe a meta chunk through plugin transforms; returns the (possibly replaced) chunk. */
  runOnMeta(ctx: any, chunk: string): string {
    for (const plugin of this.plugins) {
      if (plugin.onMeta) {
        try {
          const out = plugin.onMeta(ctx, chunk)
          if (typeof out === 'string') chunk = out
        } catch { /* error isolation */ }
      }
    }
    return chunk
  }
}
