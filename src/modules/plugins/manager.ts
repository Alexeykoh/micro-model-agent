import type { AgentPlugin } from '../types'
import type { ToolCall, ToolResult } from '../../tools/types'

export class PluginManager {
  private plugins: AgentPlugin[] = []

  register(plugin: AgentPlugin): void {
    this.plugins.push(plugin)
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  }

  getAllPlugins(): AgentPlugin[] {
    return [...this.plugins]
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

  async runOnAfterTool(ctx: any, result: ToolResult): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onAfterTool) {
        try { await plugin.onAfterTool(ctx, result) }
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

  runOnAfterThink(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onAfterThink) {
        try { plugin.onAfterThink(ctx) }
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
}
