import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { OutputRenderer, StatusInfo } from './renderer.js'
import { getTheme } from '../styling/index.js'

const CLEAR_LINE = '\r\x1b[K'

export class ReadlineRenderer implements OutputRenderer {
  private rl: ReturnType<typeof createInterface> | null = null
  private closed = false

  async start(): Promise<void> {
    this.rl = createInterface({ input, output, prompt: '' })
    this.closed = false
    this.rl.on('close', () => { this.closed = true })
  }

  private get theme() {
    return getTheme()
  }

  write(text: string): void {
    process.stdout.write(text)
  }

  writeLine(text?: string): void {
    if (text !== undefined) {
      console.log(text)
    } else {
      console.log()
    }
  }

  writeNewline(): void {
    console.log()
  }

  writeInfo(text: string): void {
    console.log(this.theme.info(text))
  }

  writeSuccess(text: string): void {
    console.log(this.theme.successMsg(text))
  }

  writeWarning(text: string): void {
    console.log(this.theme.warning(text))
  }

  writeError(text: string): void {
    console.error(this.theme.error(text))
  }

  writeDim(text: string): void {
    console.log(this.theme.dim(text))
  }

  writeBracketTag(tag: string, message: string): void {
    console.log(this.theme.bracketTag(tag, message))
  }

  writeHeading(text: string): void {
    console.log(this.theme.heading(text))
  }

  writeToolHeader(name: string): void {
    console.log()
    console.log(this.theme.toolHeader(name))
  }

  writeToolPreview(toolName: string, argsJson: string): void {
    console.log(`  ${this.theme.dim(argsJson)}`)
  }

  writeToolResult(time: string, exitCode?: number): void {
    console.log(this.theme.timingLine(time, exitCode))
  }

  writeMarkdownChunk(chunk: string): void {
    process.stdout.write(chunk)
  }

  commitMarkdown(): void {
    console.log()
  }

  writeSpinner(text?: string): void {
    process.stdout.write(this.theme.spinner(text ?? ''))
  }

  clearSpinner(): void {
    process.stdout.write(CLEAR_LINE)
  }

  updateContextUsage(text: string): void {
    console.log(`\n  ${text}\n`)
  }

  updateStatus(_info: StatusInfo): void {
    // noop — no status bar in readline mode
  }

  clear(): void {
    process.stdout.write('\x1Bc')
  }

  async prompt(msg: string): Promise<string> {
    if (!this.rl) return ''
    return this.rl.question(msg)
  }

  writeFileOutput(lines: string[], startIndex = 1): void {
    for (let i = 0; i < lines.length; i++) {
      const lineNum = (startIndex + i).toString().padStart(4)
      console.log(`${this.theme.lineNumbers(lineNum)}| ${lines[i]}`)
    }
  }

  destroy(): void {
    if (this.rl && !this.closed) {
      this.rl.close()
    }
    this.rl = null
  }
}
