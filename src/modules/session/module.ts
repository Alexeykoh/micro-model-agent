import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { SessionManager } from './manager'
import { t } from '../../i18n/index'

export class SessionModule implements AgentModule {
  name = 'session'

  private manager: SessionManager

  constructor(manager: SessionManager) {
    this.manager = manager
  }

  getSystemPromptBlock(): PromptBlock | null {
    const meta = this.manager.getActiveMeta()
    if (!meta || meta.messageCount === 0) return null
    return {
      content: t('session.info', { name: meta.name, id: meta.id, count: meta.messageCount }),
      priority: 'low',
      essential: false,
      estimatedTokens: 20,
    }
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'session',
    }
  }
}
