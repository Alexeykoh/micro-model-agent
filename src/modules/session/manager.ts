import type { SessionMeta, SessionMessage } from './types'
import type { SessionStore } from './store'

export interface SessionManagerOptions {
  model: string
  contextWindow: number
  projectDir: string
  maxSessions?: number
}

export class SessionManager {
  private store: SessionStore
  private activeId: string | null = null
  private options: SessionManagerOptions

  constructor(store: SessionStore, options: SessionManagerOptions) {
    this.store = store
    this.options = options
  }

  create(name?: string): SessionMeta {
    const now = new Date().toISOString()
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const sessionName = name || `Session ${now.slice(0, 10)}`
    const meta: SessionMeta = {
      id,
      name: sessionName,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model: this.options.model,
      contextWindow: this.options.contextWindow,
      projectDir: this.options.projectDir,
    }
    this.store.saveMeta(id, meta)
    this.activeId = id
    this.enforceMaxSessions()
    return meta
  }

  list(): SessionMeta[] {
    return this.store.listSessions()
  }

  get(id: string): SessionMeta | null {
    return this.store.loadMeta(id)
  }

  delete(id: string): void {
    this.store.deleteSession(id)
    if (this.activeId === id) {
      this.activeId = null
    }
  }

  rename(id: string, name: string): void {
    const meta = this.store.loadMeta(id)
    if (!meta) throw new Error(`Session not found: ${id}`)
    meta.name = name
    this.store.saveMeta(id, meta)
  }

  getActive(): string | null {
    return this.activeId
  }

  getActiveMeta(): SessionMeta | null {
    if (!this.activeId) return null
    return this.store.loadMeta(this.activeId)
  }

  setActive(id: string): void {
    if (!this.store.sessionExists(id)) {
      throw new Error(`Session not found: ${id}`)
    }
    this.activeId = id
  }

  appendMessage(msg: SessionMessage): void {
    if (!this.activeId) throw new Error('No active session')
    this.store.appendMessage(this.activeId, msg)
  }

  loadHistory(): SessionMessage[] {
    if (!this.activeId) return []
    return this.store.loadHistory(this.activeId)
  }

  private enforceMaxSessions(): void {
    const max = this.options.maxSessions ?? 50
    const sessions = this.store.listSessions()
    if (sessions.length > max) {
      const toDelete = sessions.slice(max)
      for (const s of toDelete) {
        this.store.deleteSession(s.id)
      }
    }
  }
}
