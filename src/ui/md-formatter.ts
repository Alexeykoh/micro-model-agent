import pc from 'picocolors'

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

export class FormattingStream {
  private buffer = ''
  private inCodeBlock = false
  private codeLang = ''
  private codeLines: string[] = []
  private onWrite: (text: string) => void

  constructor(onWrite: (text: string) => void) {
    this.onWrite = onWrite
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

    this.onWrite(this.formatLine(line))
  }

  private emitCodeBlock(): void {
    this.inCodeBlock = false
    if (this.codeLines.length > 0) {
      const code = this.codeLines.join('\n')
      const highlighted = highlight(code, this.codeLang)
      const lines = highlighted.split('\n')
      for (const l of lines) {
        this.onWrite(pc.dim(' │ ') + l)
      }
    }
    this.codeLines = []
    this.codeLang = ''
  }

  private formatLine(line: string): string {
    let result = line

    result = result.replace(/^### (.+)$/, (_, c) => pc.cyan(pc.bold(c)))
    result = result.replace(/^## (.+)$/, (_, c) => pc.cyan(pc.bold(c)))
    result = result.replace(/^# (.+)$/, (_, c) => pc.cyan(pc.bold(pc.underline(c))))

    result = result.replace(/`([^`]+)`/g, (_, c) => pc.yellow(c))

    result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => pc.bold(t))

    result = result.replace(/^- (.+)$/, (_, item) => ` ${pc.dim('•')} ${item}`)

    if (result.startsWith('|') && result.endsWith('|')) {
      const content = result.slice(1, -1)
      if (/^[\s\-:|]+$/.test(content)) {
        result = pc.dim(result)
      }
    }

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
  return pc.red(pc.bold('Error: ') + text)
}

export function formatSuccess(text: string): string {
  return pc.green(pc.bold('✓ ') + text)
}

export function formatWarning(text: string): string {
  return pc.yellow(pc.bold('⚠ ') + text)
}
