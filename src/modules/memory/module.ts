import { homedir } from 'os'
import { join } from 'path'
import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { ToolDefinition } from '../../tools/types'
import { MemoryStore } from './store'
import { rememberTool } from '../../tools/remember'
import { recallTool } from '../../tools/recall'

export class MemoryModule implements AgentModule {
  name = 'memory'
  private store: MemoryStore

  constructor(memoryDir?: string) {
    const dir = memoryDir || join(homedir(), '.mma', 'memory')
    this.store = new MemoryStore(dir)
  }

  getSystemPromptBlock(): PromptBlock | null {
    const prefs = this.store.getPreferences()
    if (Object.keys(prefs).length === 0) return null

    const prefStr = Object.entries(prefs)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')

    return {
      content: `User preferences: ${prefStr}`,
      priority: 'normal',
      essential: false,
      estimatedTokens: Math.ceil(prefStr.length / 4) + 10,
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [rememberTool, recallTool]
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'memory',
      isBuiltin: true,
      onBuildPrompt: () => {
        const prefs = this.store.getPreferences()
        if (Object.keys(prefs).length === 0) return null
        const prefStr = Object.entries(prefs)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
        return `User preferences: ${prefStr}`
      },
    }
  }

  getStore(): MemoryStore {
    return this.store
  }
}
