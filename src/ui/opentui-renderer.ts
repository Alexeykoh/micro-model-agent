import type { OutputRenderer, StatusInfo } from './renderer.js'
import { formatStatusLine } from './components/status-bar.js'

let _Text: any
let _Box: any
let _Input: any
let _ScrollBox: any

async function loadOpentui() {
  const mod = await import('@opentui/core')
  _Text = mod.Text
  _Box = mod.Box
  _Input = mod.Input
  _ScrollBox = mod.ScrollBox
  return mod
}

const theme = {
  bg: '#1a1b26',
  surface: '#24253a',
  accent: '#00d4aa',
  text: '#cdd6f4',
  textDim: '#6c7086',
  error: '#f38ba8',
  warning: '#f9e2af',
  success: '#a6e3a1',
  info: '#89b4fa',
  tool: '#cba6f7',
  border: '#313244',
  userBg: '#1e1e2e',
  assistantBg: '#181825',
}

const blockStyle = {
  flexDirection: 'column' as const,
  paddingX: 1,
  paddingY: 1,
  width: '100%' as const,
}

export class OpenTuiRenderer implements OutputRenderer {
  private renderer: any = null
  private statusModel: any = null
  private statusExtra: any = null
  private inputField: any = null
  private scrollContent: any = null
  private mdBuffer = ''
  private mdTextNode: any = null
  private inputResolve: ((value: string) => void) | null = null
  private destroyed = false

  async start(): Promise<void> {
    const mod = await loadOpentui()
    const { createCliRenderer } = mod

    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      autoFocus: true,
      consoleMode: 'disabled',
    })

    this.buildLayout()
  }

  private buildLayout(): void {
    const modelTagVNode = _Text({
      id: 'mma-model-tag',
      content: ' ◉ MMA ',
      bold: true,
      fg: theme.accent,
    })

    const statusModelVNode = _Text({
      id: 'mma-status-model',
      content: 'idle',
      fg: theme.text,
    })

    const statusExtraVNode = _Text({
      id: 'mma-status-extra',
      content: '',
      fg: theme.textDim,
    })

    const statusBar = _Box(
      { height: 1, flexDirection: 'row', alignItems: 'center' },
      modelTagVNode,
      statusModelVNode,
      _Text({ content: ' ' }),
      statusExtraVNode,
    )

    const separator = _Box(
      { height: 1 },
      _Text({ content: '─'.repeat(120), fg: theme.border }),
    )

    const inputVNode = _Input({
      id: 'mma-input',
      height: 2,
      placeholder: 'Ask MMA anything...',
      bg: theme.surface,
    })
    inputVNode.focus()

    const bottomBar = _Box(
      { flexDirection: 'column' },
      statusBar,
      separator,
      inputVNode,
    )

    const scrollContentVNode = _Box({ id: 'mma-scroll', flexDirection: 'column', padding: 1 })
    this.scrollContent = scrollContentVNode
    const scrollBox = _ScrollBox({
      stickyScroll: true,
      stickyStart: 'bottom',
      flexDirection: 'column',
      flexGrow: 1,
    })
    scrollBox.add(scrollContentVNode)

    this.renderer.root.add(
      _Box(
        { flexDirection: 'column', width: '100%', height: '100%' },
        scrollBox,
        bottomBar,
      ),
    )

    this.scrollContent = this.renderer.root.findDescendantById('mma-scroll')
    this.inputField = this.renderer.root.findDescendantById('mma-input')
    this.statusModel = this.renderer.root.findDescendantById('mma-status-model')
    this.statusExtra = this.renderer.root.findDescendantById('mma-status-extra')

    this.renderer.keyInput.on('keypress', (key: any) => {
      if (this.destroyed) return
      if (key.name === 'return' || key.name === 'kpenter' || key.name === 'linefeed') {
        this.submitInput()
      }
    })
  }

  private submitInput(): void {
    if (!this.inputField || !this.inputResolve) return
    try {
      const value = this.inputField.value
      if (value && value.trim()) {
        const trimmed = value.trim()
        this.inputField.value = ''
        this.renderer?.requestRender()
        const resolve = this.inputResolve
        this.inputResolve = null
        resolve(trimmed)
      }
    } catch {
      // ignore
    }
  }

  // --- Message blocks ---

  private copyText(text: string): void {
    try {
      this.renderer?.copyToClipboardOSC52(text)
    } catch { /* clipboard not available */ }
  }

  private addUserBlock(text: string): void {
    if (this.destroyed || !this.scrollContent) return
    const block = _Box({ ...blockStyle, backgroundColor: theme.userBg })
    const header = _Box({ flexDirection: 'row', alignItems: 'center' })
    header.add(_Text({ content: ' You ', bold: true, fg: theme.info, flexGrow: 1 }))
    header.add(_Text({
      content: ' copy ',
      fg: theme.textDim,
      onMouseDown: () => this.copyText(text),
    }))
    block.add(header)
    block.add(_Text({ content: text, fg: theme.text }))
    this.scrollContent.add(block)
    this.renderer?.requestRender()
  }

  private addToScroll(text: string, fg?: string, opts?: { dim?: boolean; bold?: boolean }): void {
    if (this.destroyed || !this.scrollContent) return
    const props: any = { content: text, fg: fg ?? theme.text }
    if (opts?.dim) props.dim = true
    if (opts?.bold) props.bold = true
    this.scrollContent.add(_Text(props))
    this.renderer?.requestRender()
  }

  // --- OutputRenderer interface ---

  write(text: string): void {
    this.addToScroll(text)
  }

  writeLine(text?: string): void {
    this.addToScroll(text ?? '')
  }

  writeNewline(): void {}

  writeInfo(text: string): void {
    this.addToScroll(text, theme.info)
  }

  writeSuccess(text: string): void {
    this.addToScroll(text, theme.success)
  }

  writeWarning(text: string): void {
    this.addToScroll(text, theme.warning)
  }

  writeError(text: string): void {
    this.addToScroll(text, theme.error)
  }

  writeDim(text: string): void {
    this.addToScroll(text, theme.textDim)
  }

  writeBracketTag(tag: string, message: string): void {
    if (tag === 'user') {
      this.addUserBlock(message)
      return
    }
    this.addToScroll(`[${tag}] ${message}`, theme.textDim)
  }

  writeHeading(text: string): void {
    this.addToScroll(text, theme.accent, { bold: true })
  }

  writeToolHeader(name: string): void {
    this.addToScroll(`◇ ${name}`, theme.tool, { bold: true })
  }

  writeToolPreview(text: string): void {
    for (const line of text.split('\n')) {
      this.addToScroll(`│ ${line}`, theme.textDim)
    }
  }

  writeToolResult(time: string, exitCode?: number): void {
    const label = exitCode !== undefined ? ` · exit ${exitCode}` : ''
    this.addToScroll(`  ⏱ ${time}s${label}`, theme.textDim)
  }

  writeMarkdownChunk(chunk: string): void {
    this.mdBuffer += chunk
    if (this.mdTextNode) {
      this.mdTextNode.content = this.mdBuffer
      this.renderer?.requestRender()
      return
    }
    if (!this.scrollContent || this.destroyed) return
    const block = _Box({ ...blockStyle, backgroundColor: theme.assistantBg })
    const header = _Box({ flexDirection: 'row', alignItems: 'center' })
    header.add(_Text({ content: ' Assistant ', bold: true, fg: theme.accent, flexGrow: 1 }))
    header.add(_Text({
      content: ' copy ',
      fg: theme.textDim,
      onMouseDown: () => this.copyText(this.mdBuffer),
    }))
    block.add(header)
    const textVNode = _Text({ id: 'mma-md-stream', content: this.mdBuffer, fg: theme.text })
    block.add(textVNode)
    this.scrollContent.add(block)
    this.mdTextNode = this.renderer?.root?.findDescendantById('mma-md-stream')
    this.renderer?.requestRender()
  }

  commitMarkdown(): void {
    this.mdTextNode = null
    this.mdBuffer = ''
  }

  writeSpinner(_text?: string): void {}

  clearSpinner(): void {}

  updateContextUsage(text: string): void {
    this.addToScroll(text, theme.textDim)
  }

  updateStatus(info: StatusInfo): void {
    if (this.destroyed) return
    if (this.statusModel) {
      this.statusModel.content = info.model
        ? `${info.provider ?? ''}/${info.model}`
        : 'connected'
    }
    const extra = formatStatusLine(info)
    if (this.statusExtra) {
      this.statusExtra.content = extra ? ` ${extra}` : ''
    }
    this.renderer?.requestRender()
  }

  async prompt(msg: string): Promise<string> {
    if (this.destroyed) return ''
    if (this.inputField) {
      this.inputField.placeholder = msg
      this.inputField.focus()
      this.renderer?.requestRender()
    }
    return new Promise((resolve) => {
      this.inputResolve = resolve
    })
  }

  writeFileOutput(lines: string[], startIndex = 1): void {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = (startIndex + i).toString().padStart(4)
      this.addToScroll(`${lineNum}| ${lines[i]}`, theme.textDim)
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.renderer) {
      try {
        this.renderer.destroy()
      } catch { /* ignore */ }
    }
    this.renderer = null
  }
}
