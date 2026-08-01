import { pc } from './colors'
import { t } from '../i18n/index'
import { formatTable, getTerminalWidth } from './table'

const KW = /\b(import|export|from|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|namespace|module|declare|abstract|async|await|yield|throw|try|catch|finally|typeof|instanceof|in|of|as|is|keyof|readonly|static|private|public|protected|get|set|constructor|this|super|void|never|any|unknown|boolean|string|number|symbol|object|true|false|null|undefined|default)\b/g
const STRING = /('[^']*'|"[^"]*"|`[^`]*`)/g
const COMMENT = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g
const NUMBER = /\b(\d+\.?\d*)\b/g
const TAG = /<\/?([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9-]*)/g
const ATTR = /\b([a-zA-Z-]+=)"([^"]*)"/g

function highlight(code: string, lang: string): string {
  if (lang === 'html' || lang === 'xml' || lang === 'svg') {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)))
    code = code.replace(ATTR, (_m, attr, val) => pc.yellow(attr) + '=' + pc.green('"' + val + '"'))
    code = code.replace(TAG, (_m, tag) => '<' + pc.cyan(tag))
  } else if (lang === 'css' || lang === 'scss' || lang === 'less') {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)))
    code = code.replace(STRING, (m) => pc.green(m))
    code = code.replace(NUMBER, (m) => pc.yellow(m))
  } else if (lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh') {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)))
    code = code.replace(STRING, (m) => pc.green(m))
  } else if (lang === 'json') {
    code = code.replace(STRING, (m) => pc.green(m))
    code = code.replace(NUMBER, (m) => pc.yellow(m))
  } else {
    // js, ts, jsx, tsx, and fallback
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)))
    code = code.replace(STRING, (m) => pc.green(m))
    code = code.replace(KW, (m) => pc.magenta(m))
    code = code.replace(NUMBER, (m) => pc.yellow(m))
  }

  return code
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return false
  const pipes = trimmed.match(/\|/g)
  return (pipes?.length ?? 0) >= 2
}

function isHorizontalRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())
}

export class FormattingStream {
  private buffer = ''
  private inCodeBlock = false
  private codeLang = ''
  private codeLines: string[] = []
  private tableBuffer: string[] = []
  private onWrite: (text: string) => void
  private width: number

  constructor(onWrite: (text: string) => void, width?: number) {
    this.onWrite = onWrite
    this.width = width ?? getTerminalWidth()
  }

  write(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this.processLine(line)
    }
  }

  flush(): void {
    if (this.inCodeBlock && this.codeLines.length > 0) {
      this.emitCodeBlock()
    }
    if (this.tableBuffer.length > 0) {
      this.flushTable()
    }
    if (this.buffer.length > 0) {
      const line = this.buffer
      this.buffer = ''
      if (line.trim() === '```' || line.trim().startsWith('```')) {
        if (this.codeLines.length > 0) {
          this.emitCodeBlock()
        }
        return
      }
      this.onWrite(this.formatLine(line))
    }
  }

  private processLine(line: string): void {
    if (line.trim() === '```' || line.trim().startsWith('```')) {
      if (this.inCodeBlock) {
        this.emitCodeBlock()
      } else {
        this.inCodeBlock = true
        this.codeLang = line.trim().slice(3).trim()
        this.codeLines = []
      }
      return
    }

    if (this.inCodeBlock) {
      this.codeLines.push(line)
      return
    }

    if (isTableRow(line)) {
      this.tableBuffer.push(line)
      return
    }

    if (this.tableBuffer.length > 0) {
      this.flushTable()
    }

    this.onWrite(this.formatLine(line))
  }

  private flushTable(): void {
    const lines = this.tableBuffer
    this.tableBuffer = []
    const hasSeparator = lines.length >= 2 && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1].trim())
    if (hasSeparator) {
      for (const l of formatTable(lines, { maxWidth: this.width })) {
        this.onWrite(l)
      }
    } else {
      for (const l of lines) {
        this.onWrite(this.formatLine(l))
      }
    }
  }

  private emitCodeBlock(): void {
    this.inCodeBlock = false
    if (this.codeLines.length > 0) {
      const code = this.codeLines.join('\n')
      const highlighted = highlight(code, this.codeLang)
      const lang = this.codeLang ? ` ${this.codeLang} ` : ' '
      const top = pc.dim(`┌─${lang}${'─'.repeat(Math.max(0, this.width - 3 - lang.length))}┐`)
      this.onWrite(top)
      for (const l of highlighted.split('\n')) {
        this.onWrite(pc.dim('│ ') + l)
      }
      this.onWrite(pc.dim(`└${'─'.repeat(Math.max(0, this.width - 1))}┘`))
    }
    this.codeLines = []
    this.codeLang = ''
  }

  private formatLine(line: string): string {
    let result = line

    const heading = result.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const content = this.formatInline(heading[2])
      if (level === 1) return pc.cyan(pc.bold(pc.underline(content)))
      return pc.cyan(pc.bold(content))
    }

    if (isHorizontalRule(result)) {
      return pc.dim('─'.repeat(Math.max(0, Math.min(this.width, 60))))
    }

    const quote = result.match(/^(>+)\s?(.*)$/)
    if (quote) {
      const depth = Math.min(quote[1].length, 4)
      const marker = pc.dim('▍'.repeat(depth))
      return `${marker} ${this.formatInline(quote[2])}`
    }

    const checkbox = result.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (checkbox) {
      const checked = checkbox[1].toLowerCase() === 'x'
      const mark = checked ? pc.green('✓') : pc.dim('☐')
      return `  ${mark} ${this.formatInline(checkbox[2])}`
    }

    const ordered = result.match(/^(\d+)[.)]\s+(.+)$/)
    if (ordered) {
      return ` ${pc.yellow(ordered[1])}. ${this.formatInline(ordered[2])}`
    }

    const bullet = result.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      return ` ${pc.dim('•')} ${this.formatInline(bullet[1])}`
    }

    return this.formatInline(result)
  }

  private formatInline(text: string): string {
    const codeSpans: string[] = []
    let result = text.replace(/`([^`]+)`/g, (_m, c) => {
      codeSpans.push(pc.yellow(c))
      return `\u0000${codeSpans.length - 1}\u0000`
    })

    result = result.replace(/\*\*(.+?)\*\*/g, (_, s) => pc.bold(s))
    result = result.replace(/~~(.+?)~~/g, (_, s) => pc.strikethrough(s))
    result = result.replace(/\*([^*]+)\*/g, (_, s) => pc.italic(s))
    result = result.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, (_m, pre, s) => pre + pc.italic(s))
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const short = url.length > 80 ? url.slice(0, 77) + '…' : url
      return `${pc.cyan(label)} ${pc.dim(`(${short})`)}`
    })

    result = result.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)])
    return result
  }
}

export function formatMarkdown(text: string): string {
  const lines: string[] = []
  const stream = new FormattingStream((l) => lines.push(l))
  stream.write(text)
  stream.flush()
  return lines.join('\n')
}

export function formatError(text: string): string {
  return pc.red(pc.bold(t('ui.error_prefix')) + text)
}

export function formatSuccess(text: string): string {
  return pc.green(pc.bold(t('ui.success_prefix')) + text)
}

export function formatWarning(text: string): string {
  return pc.yellow(pc.bold(t('ui.warning_prefix')) + text)
}
