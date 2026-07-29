import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { SessionManager } from './manager'

export class SessionModule implements AgentModule {
  name = 'session'

  private manager: SessionManager

  constructor(manager: SessionManager) {
    this.manager = manager
  }

  getSystemPromptBlock(): PromptBlock | null {
    const meta = this.manager.getActiveMeta()
    if (!meta) return null
    return {
      content: `[Session: "${meta.name}" (${meta.id}) — ${meta.messageCount} messages so far]`,
      priority: 'low',
      essential: false,
      estimatedTokens: 20,
    }
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'session',
      onSessionStart: (_ctx: any) => {
      },
      onSessionEnd: (_ctx: any) => {
      },
    }
  }
}
