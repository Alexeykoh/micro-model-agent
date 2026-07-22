import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { CompleterResult } from 'node:readline'
import type { OutputRenderer, StatusInfo } from './renderer.js'
import { getTheme } from '../styling/index.js'

/**
 * Readline-рендерер — простой текстовый вывод в терминал.
 *
 * Используется по умолчанию. Поддерживает:
 * - Автодополнение слэш-команд (Tab)
 * - Streaming markdown (пошаговый вывод)
 * - Спиннер (анимированный индикатор)
 * - Status bar (обновление в реальном времени)
 *
 * @module ui/readline-renderer
 */

const CLEAR_LINE = '\r\x1b[K'

interface SlashCommandInfo {
  name: string
  description: string
}

export class ReadlineRenderer implements OutputRenderer {
  private rl: ReturnType<typeof createInterface> | null = null
  private closed = false
  private commands: SlashCommandInfo[] = []
  private _streamRole: 'assistant' | 'subagent' | 'expert' | null = null
  private _streamStarted = false

  setCommands(cmds: SlashCommandInfo[]): void {
    this.commands = cmds
  }

  async start(): Promise<void> {
    this.rl = createInterface({
      input,
      output,
      prompt: '',
      completer: this.makeCompleter(),
    })
    this.closed = false
    this.rl.on('close', () => { this.closed = true })
  }

  private makeCompleter(): (line: string) => CompleterResult {
    return (line: string): CompleterResult => {
      const hit = line.startsWith('/')
      if (!hit) return [[], line]

      const partial = line.slice(1)
      const matches = this.commands
        .filter(c => c.name.startsWith(partial))
        .map(c => `/${c.name}`)

      return [matches.length ? matches : [], line]
    }
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
    const preview = formatToolArgs(toolName, argsJson);
    console.log(`  ${this.theme.dim(preview)}`)
  }

  writeToolResult(time: string, exitCode?: number, result?: string): void {
    console.log(this.theme.timingLine(time, exitCode))
    if (result) {
      console.log(`  ${this.theme.dim(result)}`)
    }
  }

  setStreamRole(role: 'assistant' | 'subagent' | 'expert' | null): void {
    this._streamRole = role
    this._streamStarted = false
  }

  writeMarkdownChunk(chunk: string): void {
    if (!this._streamStarted && this._streamRole) {
      const prefix = this.theme.bracketTag(this._streamRole, '')
      process.stdout.write(`\n${prefix}\n`)
      this._streamStarted = true
    }
    if (this._streamRole) {
      const colored = this.streamColor(this._streamRole, chunk)
      process.stdout.write(colored)
    } else {
      process.stdout.write(chunk)
    }
  }

  private streamColor(role: string, text: string): string {
    switch (role) {
      case 'assistant': return this.theme.assistantRole(text)
      case 'subagent': return this.theme.subagentRole(text)
      case 'expert': return this.theme.expertRole(text)
      default: return text
    }
  }

  commitMarkdown(): void {
    this._streamRole = null
    this._streamStarted = false
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

  undoLastMessage(): void {
    // readline mode — no-op, printed text cannot be undone
  }

  setMode(_mode: string): void {
    // mode is shown via prompt message formatting in REPL
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

function formatToolArgs(toolName: string, argsJson: string): string {
  if (toolName === 'subagent') {
    try {
      const args = JSON.parse(argsJson);
      const task = args.task || '';
      const files = args.existingFiles || '';
      let result = task.length > 100 ? task.slice(0, 97) + '…' : task;
      if (files) result += ` ← ${files}`;
      return result;
    } catch { /* fall through */ }
  }
  return argsJson.length > 120 ? argsJson.slice(0, 117) + '…' : argsJson;
}
