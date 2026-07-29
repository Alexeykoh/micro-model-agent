import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { gzipSync } from 'zlib'
import type { SessionMeta, SessionMessage } from './types'

export interface SessionLogEntry {
  ts: string
  type: 'tool_call' | 'tool_result' | 'assistant' | 'user' | 'system' | 'error'
  tool?: string
  args?: Record<string, unknown>
  content?: string
  success?: boolean
  duration?: number
}

export class SessionStore {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  init(): void {
    mkdirSync(this.baseDir, { recursive: true })
  }

  private sessionDir(id: string): string {
    return join(this.baseDir, id)
  }

  private metaPath(id: string): string {
    return join(this.sessionDir(id), 'meta.json')
  }

  private historyPath(id: string): string {
    return join(this.sessionDir(id), 'history.jsonl')
  }

  private sessionLogPath(id: string): string {
    return join(this.sessionDir(id), 'session.jsonl')
  }

  sessionExists(id: string): boolean {
    return existsSync(this.metaPath(id))
  }

  saveMeta(id: string, meta: SessionMeta): void {
    const dir = this.sessionDir(id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), 'utf-8')
  }

  loadMeta(id: string): SessionMeta | null {
    const path = this.metaPath(id)
    if (!existsSync(path)) return null
    try {
      const raw = readFileSync(path, 'utf-8')
      return JSON.parse(raw) as SessionMeta
    } catch {
      return null
    }
  }

  appendMessage(id: string, msg: SessionMessage): void {
    const dir = this.sessionDir(id)
    mkdirSync(dir, { recursive: true })
    appendFileSync(this.historyPath(id), JSON.stringify(msg) + '\n', 'utf-8')
    const meta = this.loadMeta(id)
    if (meta) {
      meta.messageCount = (meta.messageCount || 0) + 1
      meta.updatedAt = msg.timestamp || new Date().toISOString()
      this.saveMeta(id, meta)
    }
  }

  loadHistory(id: string): SessionMessage[] {
    const path = this.historyPath(id)
    if (!existsSync(path)) return []
    try {
      const raw = readFileSync(path, 'utf-8')
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionMessage)
    } catch {
      return []
    }
  }

  appendSessionLog(id: string, entry: SessionLogEntry): void {
    const dir = this.sessionDir(id)
    mkdirSync(dir, { recursive: true })
    appendFileSync(this.sessionLogPath(id), JSON.stringify(entry) + '\n', 'utf-8')
  }

  loadSessionLog(id: string): SessionLogEntry[] {
    const path = this.sessionLogPath(id)
    if (!existsSync(path)) return []
    try {
      const raw = readFileSync(path, 'utf-8')
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionLogEntry)
    } catch {
      return []
    }
  }

  listSessions(): SessionMeta[] {
    if (!existsSync(this.baseDir)) return []
    const entries = readdirSync(this.baseDir, { withFileTypes: true })
    const sessions: SessionMeta[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const meta = this.loadMeta(entry.name)
        if (meta) sessions.push(meta)
      }
    }
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    return sessions
  }

  deleteSession(id: string): void {
    const dir = this.sessionDir(id)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  rotateOldSessions(): void {
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const sessions = this.listSessions()

    for (const session of sessions) {
      const updatedAt = new Date(session.updatedAt)
      if (updatedAt < thirtyDaysAgo) {
        const historyPath = this.historyPath(session.id)
        if (existsSync(historyPath)) {
          const content = readFileSync(historyPath, 'utf-8')
          const compressed = gzipSync(content)
          const gzPath = join(this.baseDir, `${session.id}.jsonl.gz`)
          writeFileSync(gzPath, compressed)
          rmSync(historyPath)
        }
      }
    }
  }
}
