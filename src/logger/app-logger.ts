import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVELS

export class Logger {
  private level: LogLevel
  private prefix: string
  private logDir: string | null = null

  constructor(level: LogLevel = 'info', prefix = '') {
    this.level = level
    this.prefix = prefix
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  setLogDir(dir: string): void {
    this.logDir = dir
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  child(prefix: string): Logger {
    const childLogger = new Logger(this.level, this.prefix ? `${this.prefix}:${prefix}` : prefix)
    if (this.logDir) childLogger.setLogDir(this.logDir)
    return childLogger
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log('debug', msg, meta)
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.log('info', msg, meta)
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log('warn', msg, meta)
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.log('error', msg, meta)
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return

    const ts = new Date().toISOString()
    const prefix = this.prefix ? ` [${this.prefix}]` : ''
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''

    const line = `[${level.toUpperCase()}]${prefix} ${ts} — ${msg}${metaStr}`
    console.log(line)

    if (this.logDir) {
      try {
        appendFileSync(join(this.logDir, 'app.jsonl'), JSON.stringify({ level, ts, prefix: this.prefix, msg, meta: meta ?? null }) + '\n', 'utf-8')
      } catch { /* file logging is best-effort */ }
    }
  }
}
