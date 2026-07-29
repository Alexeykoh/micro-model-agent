import * as readline from 'readline'
import pc from 'picocolors'
import { Completer } from './completer'
import { SlashCommandProvider } from './completer'
import { SessionNameProvider } from './completer'
import { FormattingStream } from '../ui/md-formatter'
import type { Agent } from '../core/agent'
import type { AppConfig } from '../config/types'
import type { SessionManager } from '../modules/session/manager'

interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
  action(args: string[]): void | Promise<void>
}

function formatContextBar(used: number, limit: number): string {
  const pct = Math.min(100, Math.round((used / limit) * 100))
  const barLen = 20
  const filled = Math.round((pct / 100) * barLen)
  const bar = pc.green('█'.repeat(filled)) + pc.dim('░'.repeat(barLen - filled))
  const pctStr = pct >= 75 ? pc.yellow(`${pct}%`) : pc.dim(`${pct}%`)
  return `  ${bar}  ${pctStr}  ${pc.dim(`(${used} / ${limit} tokens)`)}`
}

export class Repl {
  private rl: readline.Interface
  private commands: Map<string, SlashCommand> = new Map()
  private completer: Completer = new Completer()
  private running = false
  private agent: Agent
  private config: AppConfig
  private sessionManager?: SessionManager

  constructor(agent: Agent, config: AppConfig, sessionManager?: SessionManager) {
    this.agent = agent
    this.config = config
    this.sessionManager = sessionManager
    this.registerBuiltinCommands()
    this.registerMmaCommands()
    this.registerSessionCommands()
    this.setupCompleter()
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: pc.cyan('> '),
      tabSize: 2,
      completer: (line: string) => {
        const [matches, partial] = this.completer.complete(line)
        if (matches.length > 0) return [matches, partial]
        return [[], line]
      },
    })
    this.setupListeners()
  }

  private registerBuiltinCommands(): void {
    this.registerCommand({
      name: 'help',
      description: 'Show available commands',
      action: () => this.showHelp(),
    })
    this.registerCommand({
      name: 'exit',
      description: 'Exit the REPL',
      aliases: ['quit', 'q'],
      action: () => this.stop(),
    })
    this.registerCommand({
      name: 'clear',
      description: 'Clear the screen',
      action: () => {
        console.clear()
      },
    })
  }

  private registerMmaCommands(): void {
    this.registerCommand({
      name: 'run',
      description: 'Run a prompt through the agent',
      action: async (args: string[]) => {
        if (args.length === 0) {
          console.log('Usage: /run <prompt>')
          return
        }
        const prompt = args.join(' ')
        await this.runAgent(prompt)
      },
    })
    this.registerCommand({
      name: 'config',
      description: 'Show current configuration',
      action: () => {
        const ctx = this.config.contextWindow
        const sys = Math.floor(ctx * this.config.contextBudget.systemPrompt)
        const res = Math.floor(ctx * this.config.contextBudget.responseReserve)
        console.log(`Model:       ${this.config.model}`)
        console.log(`Provider:    ${this.config.provider.type}  →  ${this.config.provider.baseUrl}`)
        console.log(`Context:     ${ctx}  (sys:${sys}  res:${res}  hist:${ctx - sys - res})`)
        console.log(`Max iters:   ${this.config.maxToolIterations}`)
        console.log(`Stuck thresh: ${this.config.stuckThreshold}`)
        console.log(`Reasoning:   ${this.config.showReasoning ? pc.green('show') : pc.dim('hide')}`)
        console.log(`Log level:   ${this.config.logLevel}`)
        console.log(`Locale:      ${this.config.locale}`)
        const meta = this.sessionManager?.getActiveMeta()
        if (meta) {
          console.log(`Session:     ${meta.name} (${meta.id})  —  ${meta.messageCount} msgs`)
        }
      },
    })
    this.registerCommand({
      name: 'reasoning',
      description: 'Toggle showing model reasoning/thinking',
      action: () => {
        this.config.showReasoning = !this.config.showReasoning
        const status = this.config.showReasoning ? pc.green('show') : pc.dim('hide')
        console.log(`Reasoning: ${status}`)
      },
    })
    this.registerCommand({
      name: 'status',
      description: 'Show agent status',
      action: () => {
        console.log(`Model: ${this.config.model}`)
        console.log(`Provider: ${this.config.provider.type} @ ${this.config.provider.baseUrl}`)
        const meta = this.sessionManager?.getActiveMeta()
        if (meta) {
          console.log(`Session: ${meta.name} (${meta.id}) — ${meta.messageCount} messages`)
        }
      },
    })
  }

  private registerSessionCommands(): void {
    if (!this.sessionManager) return

    this.registerCommand({
      name: 'sessions',
      description: 'List all sessions (* active)',
      aliases: ['ls'],
      action: () => {
        const sessions = this.sessionManager!.list()
        const active = this.sessionManager!.getActive()
        if (sessions.length === 0) {
          console.log('No sessions found. Create one with /new <name>')
          return
        }
        for (const s of sessions) {
          const marker = s.id === active ? pc.green(' *') : '  '
          const date = s.updatedAt.slice(0, 19).replace('T', ' ')
          console.log(` ${marker} ${s.id.slice(0, 12)}  ${s.name.padEnd(25)} ${date}  ${s.messageCount} msgs`)
        }
        console.log(pc.dim(`\n  Use ${pc.cyan('/resume <id>')} ${pc.dim('or')} ${pc.cyan('/resume <name>')} ${pc.dim('to switch between sessions')}`))
      },
    })

    this.registerCommand({
      name: 'new',
      description: 'Create a new session',
      aliases: ['create'],
      action: (args: string[]) => {
        const name = args.join(' ') || undefined
        const meta = this.sessionManager!.create(name)
        this.agent.clearContext()
        console.clear()
        console.log(`Created session: ${pc.cyan(meta.name)} (${pc.dim(meta.id.slice(0, 12))})`)
        console.log(pc.dim('  Chat cleared. Start typing to begin.\n'))
      },
    })

    this.registerCommand({
      name: 'resume',
      description: 'Switch to a session by id or name prefix',
      aliases: ['switch', 'use'],
      action: (args: string[]) => {
        const query = args.join(' ')
        const sessions = this.sessionManager!.list()
        if (!query) {
          console.log(pc.dim('Available sessions:'))
          const active = this.sessionManager!.getActive()
          for (const s of sessions) {
            const marker = s.id === active ? pc.green(' *') : '  '
            console.log(pc.dim(` ${marker} ${s.id.slice(0, 12)}  ${s.name}`))
          }
          console.log(pc.dim(`\n  Usage: ${pc.cyan('/resume <id|name>')}`))
          return
        }
        const match = sessions.find(
          s => s.id === query || s.id.startsWith(query) || s.name.toLowerCase().includes(query.toLowerCase())
        )
        if (!match) {
          console.log(`No session matching "${query}"`)
          return
        }
        this.sessionManager!.setActive(match.id)
        const history = this.sessionManager!.loadHistory()
        this.agent.setContext(history)
        console.log(`Resumed session: ${pc.cyan(match.name)} ${pc.dim(`(${match.id.slice(0, 12)})`)}  —  ${match.messageCount} msgs`)
        console.log(pc.dim(`  Chat history loaded. Pick up where you left off.`))
      },
    })

    this.registerCommand({
      name: 'rename',
      description: 'Rename the current session',
      action: (args: string[]) => {
        const name = args.join(' ')
        if (!name) {
          console.log('Usage: /rename <new-name>')
          return
        }
        const active = this.sessionManager!.getActive()
        if (!active) {
          console.log('No active session')
          return
        }
        this.sessionManager!.rename(active, name)
        console.log(`Session renamed to: ${name}`)
      },
    })

    this.registerCommand({
      name: 'delete',
      description: 'Delete a session by id',
      aliases: ['rm'],
      action: (args: string[]) => {
        const query = args[0]
        if (!query) {
          console.log('Usage: /delete <session-id>')
          return
        }
        const sessions = this.sessionManager!.list()
        const match = sessions.find(s => s.id === query || s.id.startsWith(query))
        if (!match) {
          console.log(`No session matching "${query}"`)
          return
        }
        this.sessionManager!.delete(match.id)
        console.log(`Deleted session: ${match.name} (${match.id})`)
      },
    })
  }

  private setupCompleter(): void {
    const slashCommands = Array.from(this.commands.keys())
    this.completer.registerProvider(new SlashCommandProvider(slashCommands))
    if (this.sessionManager) {
      this.completer.registerProvider(new SessionNameProvider(() =>
        this.sessionManager!.list().map(s => s.name)
      ))
    }
  }

  private setupListeners(): void {
    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) {
        this.rl.prompt()
        return
      }

      if (trimmed.startsWith('/')) {
        await this.executeCommand(trimmed)
      } else {
        await this.runAgent(trimmed)
      }

      if (this.running) {
        this.rl.prompt()
      }
    })

    this.rl.on('close', () => {
      this.running = false
    })
  }

  private async runAgent(input: string): Promise<void> {
    process.stdout.write('\n' + pc.green('Agent: '))

    const fmt = new FormattingStream((s) => process.stdout.write(s + '\n'))
    const result = await this.agent.run(input, (c) => fmt.write(c), (meta) => {
      process.stdout.write(meta)
    })
    fmt.flush()
    process.stdout.write('\n')

    if (!result.success) {
      console.error(pc.red(`Error: ${result.error}`))
    }
    this.showContextBar(result)
  }

  registerCommand(cmd: SlashCommand): void {
    this.commands.set(cmd.name, cmd)
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        this.commands.set(alias, cmd)
      }
    }
  }

  private async executeCommand(input: string): Promise<void> {
    const parts = input.split(/\s+/)
    const name = parts[0].slice(1)
    const args = parts.slice(1)

    const cmd = this.commands.get(name)
    if (!cmd) {
      console.log(pc.red(`Unknown command: ${name}.`), 'Type /help for available commands.')
      return
    }

    try {
      await cmd.action(args)
    } catch (err) {
      console.error(pc.red(`Command error: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private showHelp(): void {
    console.log('\nAvailable commands:')
    const shown = new Set<string>()
    for (const [name, cmd] of this.commands) {
      if (cmd.aliases?.includes(name)) continue
      if (shown.has(cmd.name)) continue
      shown.add(cmd.name)
      const aliases = cmd.aliases ? ` (${pc.dim(cmd.aliases.join(', '))})` : ''
      console.log(`  ${pc.cyan('/' + name)}${aliases}  ${pc.dim(cmd.description)}`)
    }
    console.log()
  }

  private showContextBar(result: { contextUsed?: number; contextLimit?: number }): void {
    if (result.contextUsed !== undefined && result.contextLimit !== undefined && result.contextLimit > 0) {
      console.log()
      console.log(formatContextBar(result.contextUsed, result.contextLimit))
    }
  }

  start(): void {
    this.running = true

    const divider = '─'.repeat(50)

    const ctx = this.config.contextWindow
    const sysBudget = Math.floor(ctx * this.config.contextBudget.systemPrompt)
    const resBudget = Math.floor(ctx * this.config.contextBudget.responseReserve)
    const histBudget = ctx - sysBudget - resBudget

    console.log(pc.dim(divider))
    console.log(`  ${pc.yellow('Model:')}      ${pc.white(this.config.model)}`)
    console.log(`  ${pc.yellow('Provider:')}   ${this.config.provider.type}  →  ${this.config.provider.baseUrl}`)
    console.log(`  ${pc.yellow('Context:')}    ${pc.white(String(ctx))}  ${pc.dim(`(sys:${sysBudget}  res:${resBudget}  hist:${histBudget})`)}`)

    const meta = this.sessionManager?.getActiveMeta()
    if (meta) {
      console.log(`  ${pc.yellow('Session:')}    ${pc.cyan(meta.name)} ${pc.dim(`(${meta.id.slice(0, 12)})`)}  —  ${meta.messageCount} msgs`)
    }
    console.log(pc.dim(divider))
    console.log()
    this.rl.prompt()
  }

  stop(): void {
    this.running = false
    this.agent.shutdown()
    this.rl.close()
  }
}
