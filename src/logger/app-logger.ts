const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVELS

export class Logger {
  private level: LogLevel
  private prefix: string

  constructor(level: LogLevel = 'info', prefix = '') {
    this.level = level
    this.prefix = prefix
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  child(prefix: string): Logger {
    const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix
    return new Logger(this.level, childPrefix)
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

    console.log(`[${level.toUpperCase()}]${prefix} ${ts} — ${msg}${metaStr}`)
  }
}
