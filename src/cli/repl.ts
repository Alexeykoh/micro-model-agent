import * as readline from 'readline'
import { Completer } from './completer'
import { SlashCommandProvider } from './completer'
import type { Agent } from '../core/agent'
import type { AppConfig } from '../config/types'

interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
  action(args: string[]): void | Promise<void>
}

export class Repl {
  private rl: readline.Interface
  private commands: Map<string, SlashCommand> = new Map()
  private completer: Completer = new Completer()
  private running = false
  private agent: Agent
  private config: AppConfig

  constructor(agent: Agent, config: AppConfig) {
    this.agent = agent
    this.config = config
    this.registerBuiltinCommands()
    this.registerMmaCommands()
    this.setupCompleter()
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
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
        const result = await this.agent.run(args.join(' '))
        if (result.success) {
          console.log(result.text)
        } else {
          console.error(`Error: ${result.error}`)
          if (result.text) {
            console.log(`Partial output:\n${result.text}`)
          }
        }
      },
    })
    this.registerCommand({
      name: 'config',
      description: 'Show current configuration',
      action: () => {
        console.log(`Model:       ${this.config.model}`)
        console.log(`Provider:    ${this.config.provider.type} (${this.config.provider.baseUrl})`)
        console.log(`Context:     ${this.config.contextWindow}`)
        console.log(`Max iters:   ${this.config.maxToolIterations}`)
        console.log(`Stuck thresh: ${this.config.stuckThreshold}`)
        console.log(`Log level:   ${this.config.logLevel}`)
        console.log(`Locale:      ${this.config.locale}`)
      },
    })
    this.registerCommand({
      name: 'status',
      description: 'Show agent status',
      action: () => {
        console.log(`Model: ${this.config.model}`)
        console.log(`Provider: ${this.config.provider.type} @ ${this.config.provider.baseUrl}`)
      },
    })
  }

  private setupCompleter(): void {
    const slashCommands = Array.from(this.commands.keys())
    this.completer.registerProvider(new SlashCommandProvider(slashCommands))
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
        const result = await this.agent.run(trimmed)
        if (result.success) {
          console.log(result.text)
        } else {
          console.error(`Error: ${result.error}`)
        }
      }

      if (this.running) {
        this.rl.prompt()
      }
    })

    this.rl.on('close', () => {
      this.running = false
    })
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
      console.log(`Unknown command: ${name}. Type /help for available commands.`)
      return
    }

    try {
      await cmd.action(args)
    } catch (err) {
      console.error(`Command error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private showHelp(): void {
    console.log('\nAvailable commands:')
    for (const [name, cmd] of this.commands) {
      if (cmd.aliases?.includes(name)) continue
      const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : ''
      console.log(`  /${name}${aliases}  ${cmd.description}`)
    }
    console.log()
  }

  start(): void {
    this.running = true
    console.log('MMA REPL — type /help for commands, /exit to quit\n')
    this.rl.prompt()
  }

  stop(): void {
    this.running = false
    this.rl.close()
  }
}
