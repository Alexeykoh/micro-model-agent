import * as readline from 'readline'
import pc from 'picocolors'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { Completer, SlashCommandProvider, SessionNameProvider, SubcommandProvider, SkillNameProvider } from './completer'
import { FormattingStream } from '../ui/md-formatter'
import { t } from '../i18n/index'
import type { Agent } from '../core/agent'
import type { AppConfig } from '../config/types'
import type { SessionManager } from '../modules/session/manager'
import type { SkillsModule } from '../modules/skills/module'
import type { PluginManager } from '../modules/plugins/manager'

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
  private skillsModule?: SkillsModule
  private pluginManager?: PluginManager
  private historyPath: string
  private history: string[] = []
  private maxHistory = 1000
  private lastEscTime = 0
  private readonly doubleEscDelay = 500

  constructor(agent: Agent, config: AppConfig, sessionManager?: SessionManager, skillsModule?: SkillsModule, pluginManager?: PluginManager) {
    this.agent = agent
    this.config = config
    this.sessionManager = sessionManager
    this.skillsModule = skillsModule
    this.pluginManager = pluginManager
    this.historyPath = join(homedir(), '.mma', 'repl-history')
    this.loadHistory()
    this.registerBuiltinCommands()
    this.registerMmaCommands()
    this.registerSessionCommands()
    this.registerSkillCommands()
    this.setupCompleter()
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: pc.cyan('> '),
      history: this.history,
      historySize: this.maxHistory,
      tabSize: 2,
      completer: (line: string) => {
        const [matches, partial] = this.completer.complete(line)
        if (matches.length > 0) return [matches, partial]
        return [[], line]
      },
    })
    this.setupListeners()
  }

  private loadHistory(): void {
    if (existsSync(this.historyPath)) {
      try {
        const raw = readFileSync(this.historyPath, 'utf-8')
        this.history = raw.split('\n').filter(Boolean).slice(-this.maxHistory)
      } catch {
        this.history = []
      }
    }
  }

  private saveHistory(): void {
    const allHistory = this.history.slice(-this.maxHistory)
    writeFileSync(this.historyPath, allHistory.join('\n'), 'utf-8')
  }

  private registerBuiltinCommands(): void {
    this.registerCommand({
      name: 'help',
      description: t('repl.help'),
      action: () => this.showHelp(),
    })
    this.registerCommand({
      name: 'exit',
      description: t('repl.exit'),
      aliases: ['quit', 'q'],
      action: () => this.stop(),
    })
    this.registerCommand({
      name: 'clear',
      description: t('repl.clear'),
      action: () => {
        console.clear()
      },
    })
  }

  private registerMmaCommands(): void {
    this.registerCommand({
      name: 'run',
      description: t('repl.run'),
      action: async (args: string[]) => {
        if (args.length === 0) {
          console.log(t('repl.run_usage'))
          return
        }
        const prompt = args.join(' ')
        await this.runAgent(prompt)
      },
    })
    this.registerCommand({
      name: 'config',
      description: t('repl.config'),
      action: () => {
        const ctx = this.config.contextWindow
        const sys = Math.floor(ctx * this.config.contextBudget.systemPrompt)
        const res = Math.floor(ctx * this.config.contextBudget.responseReserve)
        console.log(`${t('repl.model')}       ${this.config.model}`)
        console.log(`${t('repl.provider')}    ${this.config.provider.type}  →  ${this.config.provider.baseUrl}`)
        console.log(`${t('repl.context')}     ${ctx}  (sys:${sys}  res:${res}  hist:${ctx - sys - res})`)
        console.log(`${t('repl.max_iters')}   ${this.config.maxToolIterations}`)
        console.log(`${t('repl.stuck_thresh')} ${this.config.stuckThreshold}`)
        console.log(`${t('repl.reasoning_label')}   ${this.config.showReasoning ? pc.green(t('repl.show')) : pc.dim(t('repl.hide'))}`)
        console.log(`${t('repl.log_level')}   ${this.config.logLevel}`)
        console.log(`${t('repl.locale')}      ${this.config.locale}`)
        const meta = this.sessionManager?.getActiveMeta()
        if (meta) {
          console.log(`${t('repl.session_label')}     ${meta.name} (${meta.id})  —  ${meta.messageCount} msgs`)
        }
      },
    })
    this.registerCommand({
      name: 'reasoning',
      description: t('repl.reasoning'),
      action: () => {
        this.config.showReasoning = !this.config.showReasoning
        const status = this.config.showReasoning ? pc.green(t('repl.show')) : pc.dim(t('repl.hide'))
        console.log(t('repl.reasoning_status', { status }))
      },
    })
    this.registerCommand({
      name: 'status',
      description: t('repl.status'),
      action: () => {
        console.log(`${t('repl.model')} ${this.config.model}`)
        console.log(`${t('repl.provider')} ${this.config.provider.type} @ ${this.config.provider.baseUrl}`)
        const meta = this.sessionManager?.getActiveMeta()
        if (meta) {
          console.log(`${t('repl.session_label')} ${meta.name} (${meta.id}) — ${meta.messageCount} messages`)
        }
      },
    })
  }

  private registerSessionCommands(): void {
    if (!this.sessionManager) return

    this.registerCommand({
      name: 'sessions',
      description: t('repl.sessions'),
      aliases: ['ls'],
      action: () => {
        const sessions = this.sessionManager!.list()
        const active = this.sessionManager!.getActive()
        if (sessions.length === 0) {
          console.log(t('session.no_sessions_hint'))
          return
        }
        for (const s of sessions) {
          const marker = s.id === active ? pc.green(' *') : '  '
          const date = s.updatedAt.slice(0, 19).replace('T', ' ')
          console.log(` ${marker} ${s.id.slice(0, 12)}  ${s.name.padEnd(25)} ${date}  ${s.messageCount} msgs`)
        }
        console.log(pc.dim(`\n  ${t('repl.resume_hint')}`))
      },
    })

    this.registerCommand({
      name: 'new',
      description: t('repl.new'),
      aliases: ['create'],
      action: (args: string[]) => {
        const name = args.join(' ') || undefined
        const meta = this.sessionManager!.create(name)
        this.agent.clearContext()
        console.clear()
        console.log(`${t('session.created', { name: meta.name })} (${pc.dim(meta.id.slice(0, 12))})`)
        console.log(pc.dim(`  ${t('session.chat_cleared')}\n`))
      },
    })

    this.registerCommand({
      name: 'resume',
      description: t('repl.resume'),
      aliases: ['switch', 'use'],
      action: (args: string[]) => {
        const query = args.join(' ')
        const sessions = this.sessionManager!.list()
        if (!query) {
          console.log(pc.dim(t('session.available')))
          const active = this.sessionManager!.getActive()
          for (const s of sessions) {
            const marker = s.id === active ? pc.green(' *') : '  '
            console.log(pc.dim(` ${marker} ${s.id.slice(0, 12)}  ${s.name}`))
          }
          console.log(pc.dim(`\n  ${t('repl.resume_usage')}`))
          return
        }
        const match = sessions.find(
          s => s.id === query || s.id.startsWith(query) || s.name.toLowerCase().includes(query.toLowerCase())
        )
        if (!match) {
          console.log(t('session.no_match', { query }))
          return
        }
        this.sessionManager!.setActive(match.id)
        const history = this.sessionManager!.loadHistory()
        this.agent.setContext(history)
        console.log(`${t('session.resumed', { name: match.name })} ${pc.dim(`(${match.id.slice(0, 12)})`)}  —  ${match.messageCount} msgs`)
        console.log(pc.dim(`  ${t('session.chat_loaded')}`))
      },
    })

    this.registerCommand({
      name: 'rename',
      description: t('repl.rename'),
      action: (args: string[]) => {
        const name = args.join(' ')
        if (!name) {
          console.log(t('repl.rename_usage'))
          return
        }
        const active = this.sessionManager!.getActive()
        if (!active) {
          console.log(t('session.no_active'))
          return
        }
        this.sessionManager!.rename(active, name)
        console.log(t('session.renamed', { name }))
      },
    })

    this.registerCommand({
      name: 'delete',
      description: t('repl.delete'),
      aliases: ['rm'],
      action: (args: string[]) => {
        const query = args[0]
        if (!query) {
          console.log(t('repl.delete_usage'))
          return
        }
        const sessions = this.sessionManager!.list()
        const match = sessions.find(s => s.id === query || s.id.startsWith(query))
        if (!match) {
          console.log(t('session.no_match', { query }))
          return
        }
        this.sessionManager!.delete(match.id)
        console.log(`${t('session.deleted', { id: match.id })}: ${match.name}`)
      },
    })
  }

  private registerSkillCommands(): void {
    if (!this.skillsModule) return

    this.registerCommand({
      name: 'skill',
      description: t('repl.skill'),
      action: (args: string[]) => {
        const subcmd = args[0]
        const arg = args.slice(1).join(' ')

        if (!subcmd || subcmd === 'list') {
          const available = this.skillsModule!.getAvailable()
          if (available.length === 0) {
            console.log(t('repl.no_skills'))
            return
          }
          console.log(pc.bold(t('repl.available_skills')))
          for (const skill of available) {
            const tokens = Math.ceil(skill.content.length / 4)
            const loaded = this.skillsModule!.getLoaded().some(s => s.name === skill.name)
            const marker = loaded ? pc.green(' [loaded]') : ''
            console.log(`  ${pc.cyan(skill.name)}${marker}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`)
          }
          return
        }

        if (subcmd === 'loaded') {
          const loaded = this.skillsModule!.getLoaded()
          const budget = this.skillsModule!.getBudget()
          if (loaded.length === 0) {
            console.log(t('repl.no_loaded'))
            return
          }
          console.log(pc.bold(t('repl.loaded_skills')))
          for (const skill of loaded) {
            const tokens = Math.ceil(skill.content.length / 4)
            console.log(`  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`)
          }
          console.log(pc.dim(`\n  ${t('repl.budget', { used: budget.used, total: budget.total, remaining: budget.remaining })}`))
          return
        }

        if (subcmd === 'load') {
          if (!arg) {
            console.log(t('repl.skill_load_usage'))
            return
          }
          const result = this.skillsModule!.loadByName(arg)
          if (result.success) {
            console.log(pc.green(result.message))
          } else {
            console.log(pc.red(result.message))
          }
          return
        }

        if (subcmd === 'unload') {
          if (!arg) {
            console.log(t('repl.skill_unload_usage'))
            return
          }
          if (this.skillsModule!.unload(arg)) {
            console.log(pc.green(t('repl.skill_unloaded', { name: arg })))
          } else {
            console.log(pc.red(t('repl.skill_not_loaded', { name: arg })))
          }
          return
        }

        if (subcmd === 'search') {
          if (!arg) {
            console.log(t('repl.skill_search_usage'))
            return
          }
          const results = this.skillsModule!.search(arg)
          if (results.length === 0) {
            console.log(t('repl.no_skill_match', { query: arg }))
            return
          }
          console.log(pc.bold(t('repl.skills_matching', { query: arg })))
          for (const skill of results) {
            const tokens = Math.ceil(skill.content.length / 4)
            console.log(`  ${pc.cyan(skill.name)}  ${pc.dim(`(${tokens} tokens)`)}  ${skill.description.slice(0, 60)}`)
          }
          return
        }

        console.log(pc.red(t('repl.skill_unknown_sub', { subcmd })))
        console.log(t('repl.skill_usage'))
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
    if (this.skillsModule) {
      this.completer.registerProvider(new SubcommandProvider('skill', ['list', 'loaded', 'load', 'unload', 'search']))
      this.completer.registerProvider(new SkillNameProvider(this.skillsModule))
    }
  }

  private setupListeners(): void {
    let multiLineBuffer = ''
    let inMultiLine = false

    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim()
      if (trimmed) {
        this.history.push(trimmed)
        if (this.history.length > this.maxHistory) {
          this.history = this.history.slice(-this.maxHistory)
        }
      }

      if (inMultiLine) {
        multiLineBuffer += '\n' + line
        if (!this.isMultiLineInput(multiLineBuffer)) {
          inMultiLine = false
          const fullInput = multiLineBuffer.trim()
          multiLineBuffer = ''
          if (fullInput) {
            if (fullInput.startsWith('/')) {
              await this.executeCommand(fullInput)
            } else {
              await this.runAgent(fullInput)
            }
          }
          if (this.running) {
            this.rl.setPrompt(pc.cyan('> '))
            this.rl.prompt()
          }
        } else {
          this.rl.setPrompt(pc.cyan('... '))
          this.rl.prompt()
        }
        return
      }

      if (this.isMultiLineInput(trimmed)) {
        inMultiLine = true
        multiLineBuffer = trimmed
        this.rl.setPrompt(pc.cyan('... '))
        this.rl.prompt()
        return
      }

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

    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin)
      process.stdin.on('keypress', (str, key) => {
        if (key.name === 'escape') {
          const now = Date.now()
          if (now - this.lastEscTime < this.doubleEscDelay) {
            console.log(pc.yellow('\n\n[Ctrl+C] Остановка агента...'))
            this.agent.shutdown()
            this.running = false
            this.saveHistory()
            this.rl.close()
            process.exit(0)
          }
          this.lastEscTime = now
        }
      })
    }
  }

  private isMultiLineInput(line: string): boolean {
    if (line.endsWith('\\')) return true

    const openBraces = (line.match(/\{/g) || []).length
    const closeBraces = (line.match(/\}/g) || []).length
    if (openBraces > closeBraces) return true

    return false
  }

  private async runAgent(input: string): Promise<void> {
    process.stdout.write('\n' + pc.green(t('repl.agent')))

    const fmt = new FormattingStream((s) => process.stdout.write(s + '\n'))
    const result = await this.agent.run(input, (c) => fmt.write(c), (meta) => {
      process.stdout.write(meta)
    })
    fmt.flush()
    process.stdout.write('\n')

    if (!result.success) {
      console.error(pc.red(`${t('error.prefix')}${result.error}`))
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
      console.log(pc.red(t('cli.unknown_cmd', { name })), t('cli.help_hint'))
      return
    }

    try {
      await cmd.action(args)
    } catch (err) {
      console.error(pc.red(t('error.command_error', { message: err instanceof Error ? err.message : String(err) })))
    }
  }

  private showHelp(): void {
    console.log(t('cli.available_cmds'))
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

    console.log(pc.bold(pc.green(t('repl.title'))))
    const divider = '─'.repeat(50)

    const ctx = this.config.contextWindow
    const sysBudget = Math.floor(ctx * this.config.contextBudget.systemPrompt)
    const resBudget = Math.floor(ctx * this.config.contextBudget.responseReserve)
    const histBudget = ctx - sysBudget - resBudget

    console.log(pc.dim(divider))
    console.log(`  ${pc.yellow(t('repl.model'))}      ${pc.white(this.config.model)}`)
    console.log(`  ${pc.yellow(t('repl.provider'))}   ${this.config.provider.type}  →  ${this.config.provider.baseUrl}`)
    console.log(`  ${pc.yellow(t('repl.context'))}    ${pc.white(String(ctx))}  ${pc.dim(`(sys:${sysBudget}  res:${resBudget}  hist:${histBudget})`)}`)

    if (this.skillsModule) {
      const budget = this.skillsModule.getBudget()
      console.log(`  ${pc.yellow(t('repl.skills_label'))}     ${pc.white(String(this.skillsModule.getAvailable().length))} available, ${pc.dim(`budget: ${budget.total} tokens`)}`)
    }

    if (this.pluginManager) {
      const plugins = this.pluginManager.getAllPlugins().filter(p => !p.isBuiltin)
      if (plugins.length > 0) {
        const pluginNames = plugins.map(p => p.name).join(', ')
        console.log(`  ${pc.yellow(t('repl.plugins_label'))}    ${pc.white(String(plugins.length))} active  ${pc.dim(`(${pluginNames})`)}`)
      }
    }

    const meta = this.sessionManager?.getActiveMeta()
    if (meta) {
      console.log(`  ${pc.yellow(t('repl.session_label'))}    ${pc.cyan(meta.name)} ${pc.dim(`(${meta.id.slice(0, 12)})`)}  —  ${meta.messageCount} msgs`)
    }
    console.log(pc.dim(divider))
    console.log()
    this.rl.prompt()
  }

  stop(): void {
    this.running = false
    this.saveHistory()
    this.agent.shutdown()
    this.rl.close()
  }
}
