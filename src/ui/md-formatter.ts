import { getTheme } from '../styling/index.js'
import type { ThemeEngine } from '../styling/engine.js'

function th(): ThemeEngine {
  return getTheme()
}

// ─── Syntax highlighting ───────────────────────────────────

const TOKEN_COLORS: Record<string, string> = {
  keyword: 'symbolName',
  string: 'success',
  number: 'timing',
  comment: 'dim',
  function: 'highlight',
  type: 'toolName',
  builtin: 'info',
  operator: 'dim',
  punctuation: 'dim',
  property: 'filePath',
  tag: 'error',
  attr: 'symbolName',
  value: 'string',
}

function color(t: string, token: string): string {
  const key = TOKEN_COLORS[token]
  if (!key) return t
  const engine = th()
  const fn = (engine as any)[key] as ((s: string) => string) | undefined
  return fn ? fn.call(engine, t) : t
}

function di(t: string): string { return th().dim(t) }
function bo(t: string): string { return th().highlight(t) }

const JS_KEYWORDS = 'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|as|satisfies|implements|interface|type|enum|declare|namespace|module|abstract|private|protected|public|readonly'
const TS_TYPES = 'string|number|boolean|null|undefined|void|never|any|unknown|bigint|symbol|object|Promise|Array|Map|Set|Record|Partial|Required|Pick|Omit|Exclude|Extract|NonNullable|ReturnType|Parameters|Readonly|Error'
const JS_BUILTINS = 'console|Math|JSON|Promise|Array|Map|Set|Object|String|Number|Boolean|Date|RegExp|Error|Symbol|BigInt|parseInt|parseFloat|isNaN|isFinite|undefined|null|true|false|globalThis|window|document|process|require|module|__dirname|__filename|Buffer|setTimeout|setInterval|clearTimeout|clearInterval|fetch|Blob|File|FormData|Headers|Request|Response|URL|URLSearchParams|TextEncoder|TextDecoder|atob|btoa|crypto|performance|localStorage|sessionStorage|Intl'
const PY_KEYWORDS = 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|None|True|False|self|cls'
const PY_BUILTINS = 'print|len|range|type|int|str|float|list|dict|set|tuple|bool|open|map|filter|zip|enumerate|sorted|reversed|any|all|sum|min|max|abs|round|hasattr|getattr|setattr|isinstance|issubclass|super|property|staticmethod|classmethod|object|Exception|ValueError|TypeError|KeyError|IndexError|AttributeError|ImportError|FileNotFoundError|StopIteration|RuntimeError|NotImplementedError'

function highlightTokenize(source: string, patterns: { re: RegExp; token: string }[]): string {
  let result = ''
  let last = 0
  const all: { start: number; end: number; token: string; text: string }[] = []

  for (const p of patterns) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(source)) !== null) {
      all.push({ start: m.index, end: m.index + m[0].length, token: p.token, text: m[0] })
    }
  }

  all.sort((a, b) => a.start - b.start || b.end - a.end)

  for (const item of all) {
    if (item.start < last) continue
    if (item.start > last) {
      result += source.slice(last, item.start)
    }
    result += color(item.text, item.token)
    last = item.end
  }

  if (last < source.length) {
    result += source.slice(last)
  }

  return result
}

function highlightJS(source: string): string {
  const patterns = [
    { re: new RegExp(`\\b(${JS_KEYWORDS})\\b`, 'g'), token: 'keyword' },
    { re: new RegExp(`\\b(${TS_TYPES})\\b`, 'g'), token: 'type' },
    { re: new RegExp(`\\b(${JS_BUILTINS})\\b`, 'g'), token: 'builtin' },
    { re: /\/\/.*/g, token: 'comment' },
    { re: /\/\*[\s\S]*?\*\//g, token: 'comment' },
    { re: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, token: 'string' },
    { re: /\$\{[^}]*\}/g, token: 'string' },
    { re: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, token: 'number' },
    { re: /(?:function|=>|get|set)\s+(\w+)\s*\(/g, token: 'function' },
    { re: /(\w[\w.]*)\s*\(/g, token: 'function' },
    { re: /(===|!==|==|!=|=>|<=|>=|\+\+|--|&&|\|\||\?\?|\.\.\.)/g, token: 'operator' },
    { re: /[{}()\[\];,.]/g, token: 'punctuation' },
  ]
  return highlightTokenize(source, patterns)
}

function highlightJSON(source: string): string {
  const patterns = [
    { re: /"((?:[^"\\]|\\.)*)"\s*:/g, token: 'property' },
    { re: /"(?:[^"\\]|\\.)*"/g, token: 'string' },
    { re: /\b(true|false|null)\b/g, token: 'keyword' },
    { re: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, token: 'number' },
  ]
  return highlightTokenize(source, patterns)
}

function highlightPy(source: string): string {
  const patterns = [
    { re: new RegExp(`\\b(${PY_KEYWORDS})\\b`, 'g'), token: 'keyword' },
    { re: new RegExp(`\\b(${PY_BUILTINS})\\b`, 'g'), token: 'builtin' },
    { re: /#.*/g, token: 'comment' },
    { re: /'''[\s\S]*?'''|"""[\s\S]*?"""/g, token: 'string' },
    { re: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, token: 'string' },
    { re: /\bf-'(?:[^'\\]|\\.)*'|f"(?:[^"\\]|\\.)*"/g, token: 'string' },
    { re: /\b\d+(?:\.\d+)?[jJ]?\b/g, token: 'number' },
    { re: /(\w+)\s*\(/g, token: 'function' },
  ]
  return highlightTokenize(source, patterns)
}

function highlightShell(source: string): string {
  const patterns = [
    { re: /#.*/g, token: 'comment' },
    { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, token: 'string' },
    { re: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|export|local|source|\.|set|unset|read|echo|printf|cd|pwd|ls|mkdir|rm|cp|mv|cat|grep|sed|awk|find|xargs|chmod|chown|sudo|apt|yum|npm|npx|bun|node|docker|git|curl|wget|tar|gzip|unzip|make|cmake|pip|python|tsc|eslint|prettier)\b/g, token: 'builtin' },
    { re: /\b\d+\b/g, token: 'number' },
  ]
  return highlightTokenize(source, patterns)
}

function highlightDiff(source: string): string {
  const lines = source.split('\n')
  const result = lines.map(line => {
    if (line.startsWith('+')) return th().success(line)
    if (line.startsWith('-')) return th().error(line)
    if (line.startsWith('@@')) return th().info(line)
    if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) return th().dim(line)
    return line
  }).join('\n')
  return result
}

function highlightYaml(source: string): string {
  const patterns = [
    { re: /#.*/g, token: 'comment' },
    { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, token: 'string' },
    { re: /\b(true|false|yes|no|on|off|null|~)\b/g, token: 'keyword' },
    { re: /\b-?\d+(?:\.\d+)?\b/g, token: 'number' },
    { re: /^[\t ]*(\w[\w.-]*)(?=\s*:)/gm, token: 'property' },
  ]
  return highlightTokenize(source, patterns)
}

function highlightHTML(source: string): string {
  const patterns = [
    { re: /&[\w#]+;/g, token: 'builtin' },
    { re: /&[\w#]+;/g, token: 'builtin' },
  ]
  let result = source
  result = result.replace(/(&lt;|<)(\/?)(\w[\w-]*)/g, (m, o, slash, tag) => o + slash + th().error(tag))
  result = result.replace(/(\w[\w-]*)\s*=\s*"(?:[^"\\]|\\.)*"/g, (m, attr) => th().symbolName(attr) + m.slice(attr.length))
  result = result.replace(/(\w[\w-]*)\s*=\s*'(?:[^'\\]|\\.)*'/g, (m, attr) => th().symbolName(attr) + m.slice(attr.length))
  return result
}

function highlightCSS(source: string): string {
  const patterns = [
    { re: /\/\*[\s\S]*?\*\//g, token: 'comment' },
    { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, token: 'string' },
    { re: /\b(\d+)(?:px|em|rem|vh|vw|%|s|ms)?\b/g, token: 'number' },
    { re: /(#[\da-fA-F]{3,8})\b/g, token: 'string' },
    { re: /\b(import|from|url|important|and|or|not|only|global|layer|container)\b/g, token: 'keyword' },
    { re: /\.(-?[\w-]+)/g, token: 'function' },
    { re: /#(-?[\w-]+)/g, token: 'type' },
  ]
  return highlightTokenize(source, patterns)
}

const KNOWN_LANGS = new Set([
  'js', 'javascript', 'ts', 'typescript', 'tsx', 'jsx',
  'json', 'py', 'python', 'sh', 'bash', 'shell', 'zsh',
  'diff', 'patch', 'yaml', 'yml', 'html', 'xml', 'svg',
  'css', 'scss', 'less', 'md', 'markdown', 'text', 'plain',
])

function getHighlighter(lang: string): ((code: string) => string) | null {
  lang = lang.toLowerCase()
  const langMap: Record<string, (code: string) => string> = {
    js: highlightJS,
    javascript: highlightJS,
    ts: highlightJS,
    typescript: highlightJS,
    tsx: highlightJS,
    jsx: highlightJS,
    json: highlightJSON,
    py: highlightPy,
    python: highlightPy,
    sh: highlightShell,
    bash: highlightShell,
    shell: highlightShell,
    zsh: highlightShell,
    diff: highlightDiff,
    patch: highlightDiff,
    yaml: highlightYaml,
    yml: highlightYaml,
    html: highlightHTML,
    xml: highlightHTML,
    svg: highlightHTML,
    css: highlightCSS,
    scss: highlightCSS,
    less: highlightCSS,
  }
  return langMap[lang] || null
}

function detectLangFromCode(code: string): string | null {
  const firstLine = code.split('\n')[0].trim()
  if (firstLine && KNOWN_LANGS.has(firstLine.toLowerCase())) {
    return firstLine
  }
  return null
}

// ─── Markdown formatting ───────────────────────────────────

const BOLD_RE = /\*\*(.+?)\*\*/g
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g
const INLINE_CODE_RE = /`([^`]+)`/g
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm
const HR_RE = /^(?:---|\*\*\*|___)\s*$/gm
const STRIKETHROUGH_RE = /~~(.+?)~~/g
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const CHECKBOX_DONE_LINE_RE = /^(\s*)[-*+]\s+\[x\]\s+(.*)$/gim
const CHECKBOX_TODO_LINE_RE = /^(\s*)[-*+]\s+\[\s*\]\s+(.*)$/gim
const BLOCKQUOTE_LINE_RE = /^>\s?(.*)$/gm
const UNORDERED_LIST_LINE_RE = /^(\s*)([-*+])\s+(.+)$/gm
const ORDERED_LIST_LINE_RE = /^(\s*)(\d+)\.\s+(.+)$/gm
const TABLE_LINE_RE = /^\|.+\|$/gm

function formatInlineMd(text: string): string {
  let result = text

  result = result.replace(STRIKETHROUGH_RE, (_, content) => th().dim(content))
  result = result.replace(LINK_RE, (_, linkText, url) => `${th().link(linkText)} ${th().dim(`(${url})`)}`)
  result = result.replace(BOLD_RE, (_, content) => bo(content))
  result = result.replace(ITALIC_RE, (_, content) => th().dim(content))
  result = result.replace(INLINE_CODE_RE, (_, code) => th().symbolName(code))
  result = result.replace(HR_RE, (_) => th().dim('─'.repeat(40)))
  result = result.replace(HEADING_RE, (_, _h, content) => th().heading(content))
  result = result.replace(CHECKBOX_DONE_LINE_RE, (_, indent, rest) => `${indent}${th().success('☑')} ${rest}`)
  result = result.replace(CHECKBOX_TODO_LINE_RE, (_, indent, rest) => `${indent}${th().dim('☐')} ${rest}`)
  result = result.replace(BLOCKQUOTE_LINE_RE, (_, content) => `${th().dim('│')} ${content}`)
  result = result.replace(UNORDERED_LIST_LINE_RE, (_, indent, bullet, content) => `${indent}${th().symbolName(bullet)} ${content}`)
  result = result.replace(ORDERED_LIST_LINE_RE, (_, indent, num, content) => `${indent}${th().symbolName(num + '.')} ${content}`)
  result = result.replace(TABLE_LINE_RE, (line) => formatTableRow(line))

  return result
}

function formatBlockquoteLine(line: string): string {
  const content = line.replace(/^>\s?/, '')
  const bar = th().dim('│')
  return `${bar} ${formatInlineMd(content)}`
}

function formatTableRow(line: string): string {
  const isSep = /^\|[\s:-]+\|/.test(line.replace(/-+/g, '-'))
  if (isSep) {
    const parts = line.split('|').filter(p => p.trim())
    const dashes = parts.map(() => th().dim('─'.repeat(1))).join(th().dim('─│─'))
    return th().dim('├─') + dashes + th().dim('─┤')
  }
  const cells = line.split('|').filter(p => p.trim().length > 0 || line.includes('|'))
  if (cells.length === 0) return line
  const rendered = cells.map(c => {
    const trimmed = c.trim()
    return trimmed ? ` ${formatInlineMd(trimmed)} ` : '   '
  })
  return th().dim('│') + rendered.join(th().dim('│')) + th().dim('│')
}

function formatMdBlock(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (inTable) {
      if (!line.trim().startsWith('|')) {
        inTable = false
        result.push(th().dim('└' + '─'.repeat(3) + '┘'))
      } else {
        result.push(formatTableRow(line))
        continue
      }
    }

    if (!inCode) {
      const fenceMatch = line.match(/^```(\w*)/)
      if (fenceMatch) {
        inCode = true
        codeLang = fenceMatch[1]
        codeLines = []
        result.push(th().info(fenceMatch[0]))
        continue
      }

      if (/^#{1,6}\s+/.test(line)) {
        result.push(th().heading(line))
        continue
      }

      if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
        result.push(th().dim('─'.repeat(40)))
        continue
      }

      if (/^>\s?/.test(line)) {
        result.push(formatBlockquoteLine(line))
        continue
      }

      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        if (!inTable) {
          inTable = true
          result.push(th().dim('┌' + '─'.repeat(3) + '┐'))
        }
        result.push(formatTableRow(line))
        continue
      }

      result.push(formatInlineMd(line))
    } else {
      if (!codeLang && codeLines.length === 0) {
        const trimmed = line.trim()
        if (KNOWN_LANGS.has(trimmed)) {
          codeLang = trimmed
          continue
        }
      }

      const fenceEnd = line.match(/^```/)
      if (fenceEnd) {
        inCode = false
        const highlighted = highlightCodeBlock(codeLines.join('\n'), codeLang)
        if (highlighted) result.push(highlighted)
        result.push(th().info('```'))
        codeLang = ''
        codeLines = []
        continue
      }
      codeLines.push(line)
    }
  }

  if (inTable) result.push(th().dim('└' + '─'.repeat(3) + '┘'))
  if (inCode && codeLines.length > 0) {
    const highlighted = highlightCodeBlock(codeLines.join('\n'), codeLang)
    if (highlighted) result.push(highlighted)
  }

  return result.join('\n')
}

function highlightCodeBlock(code: string, lang: string): string {
  const highlighter = getHighlighter(lang)
  if (highlighter) {
    return highlighter(code)
  }
  return code
}

// ─── Streaming formatter ───────────────────────────────────

export class MdStreamFormatter {
  private textBuf = ''
  private inCode = false
  private codeLang = ''
  private codeBuf = ''
  private langDetected = false

  private tryDetectLang(): void {
    if (this.codeLang || this.langDetected) return
    if (!this.codeBuf) return
    const detected = detectLangFromCode(this.codeBuf)
    if (detected) {
      this.codeLang = detected
      this.langDetected = true
      const lines = this.codeBuf.split('\n')
      lines.shift()
      this.codeBuf = lines.join('\n')
    }
  }

  push(chunk: string): string {
    if (!this.inCode) {
      this.textBuf += chunk
      const fenceIdx = this.textBuf.search(/^```(\w*)\s*$/m)
      if (fenceIdx !== -1) {
        const fenceMatch = this.textBuf.slice(fenceIdx).match(/^```(\w*)/)
        const fenceStr = fenceMatch ? fenceMatch[0] : '```'
        const codeLang = fenceMatch ? (fenceMatch[1] || '') : ''
        const beforeLines = this.textBuf.slice(0, fenceIdx).split('\n')
        const before = beforeLines.slice(0, -1).join('\n')
        this.codeLang = codeLang
        this.langDetected = !!codeLang
        const afterFence = this.textBuf.slice(fenceIdx + fenceStr.length)
        this.codeBuf = afterFence.startsWith('\n') ? afterFence.slice(1) : afterFence
        this.inCode = true
        this.textBuf = ''
        this.tryDetectLang()
        const formatted = before ? formatInlineMd(before) + '\n' : ''
        const output = formatted + th().info('```' + this.codeLang) + '\n'
        if (this.codeBuf) {
          const closeIdx = this.codeBuf.indexOf('```')
          if (closeIdx !== -1) {
            const code = this.codeBuf.slice(0, closeIdx)
            const after = this.codeBuf.slice(closeIdx + 3)
            this.codeBuf = ''
            this.inCode = false
            const highlighted = highlightCodeBlock(code, this.codeLang)
            const codeOut = highlighted || code
            return output + codeOut + (codeOut.endsWith('\n') ? '' : '\n') + th().info('```') + '\n' + formatInlineMd(after)
          }
        }
        return output
      }
      const partialFence = this.textBuf.match(/`{2,3}$/)
      if (partialFence) {
        return ''
      }
      const partialHeading = this.textBuf.match(/^#{1,6}\s*$/)
      if (partialHeading) {
        return ''
      }
      const output = formatInlineMd(this.textBuf)
      this.textBuf = ''
      return output
    }
    this.codeBuf += chunk
    this.tryDetectLang()
    const closeIdx = this.codeBuf.indexOf('```')
    if (closeIdx !== -1) {
      const code = this.codeBuf.slice(0, closeIdx)
      const after = this.codeBuf.slice(closeIdx + 3)
      this.codeBuf = ''
      this.inCode = false
      const highlighted = highlightCodeBlock(code, this.codeLang)
      const codeOut = highlighted || code
      return codeOut + (codeOut.endsWith('\n') ? '' : '\n') + th().info('```') + '\n' + formatInlineMd(after)
    }
    return ''
  }

  flush(): string {
    let result = ''
    if (this.inCode) {
      if (this.codeBuf) {
        const flushed = highlightCodeBlock(this.codeBuf, this.codeLang) || this.codeBuf
        result += flushed + (flushed.endsWith('\n') ? '' : '\n')
      }
      result += th().info('```')
      this.inCode = false
      this.codeBuf = ''
      this.codeLang = ''
      this.langDetected = false
    }
    if (this.textBuf) {
      result += formatInlineMd(this.textBuf)
      this.textBuf = ''
    }
    return result
  }

  reset(): void {
    this.textBuf = ''
    this.inCode = false
    this.codeLang = ''
    this.codeBuf = ''
    this.langDetected = false
  }
}

export { formatInlineMd, formatMdBlock, highlightCodeBlock }
