import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface HistoryMessage {
  role: string
  content: string
  name?: string
  timestamp: string
}

export class SessionHistoryWriter {
  private historyPath: string

  constructor(sessionsDir: string, sessionId: string) {
    const sessionDir = join(sessionsDir, sessionId)
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true })
    }
    this.historyPath = join(sessionDir, 'history.jsonl')
  }

  append(msg: HistoryMessage): void {
    appendFileSync(this.historyPath, JSON.stringify(msg) + '\n', 'utf-8')
  }
}
