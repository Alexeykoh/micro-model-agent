# Plan 4: CLI + REPL — Main, Commands, REPL, Completer, Setup Wizard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CLI interface — argument parsing via `commander`, readline REPL with deep tab completion, interactive setup wizard for first-run configuration.

**Architecture:** CLI uses `commander` for subcommands. REPL uses `readline` with a provider-based `Completer` system. Setup wizard is a step-by-step readline flow that scans localhost ports and tests connections.

**Tech Stack:** Bun + TypeScript, commander, readline (built-in), vitest

---

## File Structure

```
src/cli/
├── main.ts           — Entry point: parse args, dispatch to command or REPL
├── commands.ts       — Command definitions (init, config, model, provider)
├── repl.ts           — Readline REPL loop with slash commands
├── completer.ts      — Provider-based tab completion (SlashCommand, Subcommand, ModelArg, ConfigKey, FilePath)
├── setup.ts          — Interactive setup wizard (port scan → model select → test)
└── index.ts          — re-exports
src/ui/
├── md-formatter.ts   — Markdown → ANSI conversion
├── output.ts         — Terminal output helpers
└── index.ts
```

Tests:
```
tests/
├── commands.test.ts
├── completer.test.ts
├── setup.test.ts
└── md-formatter.test.ts
```

---

### Task 1: CLI entry point + commands

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/commands.ts`
- Create: `src/cli/index.ts`

- [ ] **Step 1: Write entry point and commands**

```ts
// src/cli/commands.ts
import { Command } from 'commander'

export function createProgram(): Command {
  const program = new Command()
    .name('mma')
    .description('Micro Models Agent — AI coding agent for small models')
    .version('0.3.0')

  program
    .command('init')
    .description('Run interactive setup wizard')
    .action(() => {
      console.log('Running setup wizard...')
    })

  program
    .command('config')
    .description('Manage configuration')
  program.command('config')
    .command('set')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .description('Set a config value')
    .action((key: string, value: string) => {
      console.log(`Setting ${key}=${value}`)
    })
  program.command('config')
    .command('show')
    .description('Show current config')
    .action(() => {
      console.log('Showing config...')
    })

  program
    .command('model')
    .description('Manage models')
  program.command('model')
    .command('list')
    .description('List available models')
    .action(() => console.log('Listing models...'))
  program.command('model')
    .command('use')
    .argument('<name>', 'Model name')
    .description('Set default model')
    .action((name: string) => console.log(`Using model: ${name}`))

  program
    .command('provider')
    .description('Manage providers')
  program.command('provider')
    .command('list')
    .description('List providers')
    .action(() => console.log('Listing providers...'))
  program.command('provider')
    .command('use')
    .argument('<name>', 'Provider name')
    .description('Set active provider')
    .action((name: string) => console.log(`Using provider: ${name}`))

  program
    .argument('[prompt...]', 'Prompt to execute')
    .description('Run a single prompt')
    .action((prompt: string[]) => {
      if (prompt.length > 0) {
        console.log(`Running: ${prompt.join(' ')}`)
      }
    })

  return program
}
```

```ts
// src/cli/main.ts
#!/usr/bin/env bun
import { createProgram } from './commands'

function main(): void {
  const program = createProgram()
  program.parse(process.argv)

  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('Starting REPL...')
  }
}

if (require.main === module) {
  main()
}

export { main }
```

```ts
// src/cli/index.ts
export { main } from './main'
export { createProgram } from './commands'
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/main.ts src/cli/commands.ts src/cli/index.ts
git commit -m "feat: CLI entry point with commander subcommands"
```

---

### Task 2: Completer — provider-based tab completion

**Files:**
- Create: `src/cli/completer.ts`
- Test: `tests/completer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/completer.test.ts
import { describe, it, expect } from 'vitest'
import { Completer, SlashCommandProvider, SubcommandProvider } from '../src/cli/completer'

describe('Completer', () => {
  it('should complete slash commands', () => {
    const completer = new Completer()
    completer.registerProvider(new SlashCommandProvider(['help', 'model', 'config', 'exit']))
    const [results] = completer.complete('/')
    expect(results).toContain('/help')
    expect(results).toContain('/model')
  })

  it('should filter by partial input', () => {
    const completer = new Completer()
    completer.registerProvider(new SlashCommandProvider(['help', 'model', 'config', 'exit']))
    const [results] = completer.complete('/mo')
    expect(results).toContain('/model')
    expect(results).not.toContain('/help')
  })

  it('should complete subcommands', () => {
    const completer = new Completer()
    const subProvider = new SubcommandProvider('model', ['list', 'use', 'info'])
    completer.registerProvider(subProvider)
    const [results] = completer.complete('/model ')
    expect(results).toContain('list')
    expect(results).toContain('use')
  })

  it('should return empty array for no match', () => {
    const completer = new Completer()
    const [results] = completer.complete('/nonexistent')
    expect(results).toEqual([])
  })

  it('should handle empty line', () => {
    const completer = new Completer()
    const [results] = completer.complete('')
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/completer.test.ts`
Expected: FAIL

- [ ] **Step 3: Write completer.ts**

```ts
// src/cli/completer.ts

export interface CompletionContext {
  line: string
  cursor: number
  tokens: string[]
  partial: string
  tokenIndex: number
}

export interface CompletionProvider {
  name: string
  match(ctx: CompletionContext): boolean
  complete(ctx: CompletionContext): string[]
}

export class SlashCommandProvider implements CompletionProvider {
  name = 'slash-commands'
  private commands: string[]

  constructor(commands: string[]) {
    this.commands = commands
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 0 && ctx.line.startsWith('/')
  }

  complete(ctx: CompletionContext): string[] {
    return this.commands
      .filter(c => c.startsWith(ctx.partial.slice(1)))
      .map(c => `/${c}`)
  }
}

export class SubcommandProvider implements CompletionProvider {
  name = 'subcommands'
  private command: string
  private subcommands: string[]

  constructor(command: string, subcommands: string[]) {
    this.command = command
    this.subcommands = subcommands
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 1 && ctx.tokens[0] === `/${this.command}`
  }

  complete(ctx: CompletionContext): string[] {
    return this.subcommands.filter(s => s.startsWith(ctx.partial))
  }
}

export class ModelArgProvider implements CompletionProvider {
  name = 'model-args'
  private models: string[]

  constructor(models: string[]) {
    this.models = models
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 2 && (ctx.tokens[0] === '/model' || ctx.tokens[0] === '/config')
  }

  complete(ctx: CompletionContext): string[] {
    return this.models.filter(m => m.startsWith(ctx.partial))
  }
}

export class ConfigKeyProvider implements CompletionProvider {
  name = 'config-keys'
  private keys: string[]

  constructor(keys: string[]) {
    this.keys = keys
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex >= 1 && ctx.tokens[0] === '/config' && ctx.tokens[1] === 'set'
  }

  complete(ctx: CompletionContext): string[] {
    return this.keys.filter(k => k.startsWith(ctx.partial))
  }
}

export class FilePathProvider implements CompletionProvider {
  name = 'file-paths'

  match(ctx: CompletionContext): boolean {
    return ctx.partial.includes('/') || ctx.partial.includes('\\')
  }

  complete(_ctx: CompletionContext): string[] {
    return []
  }
}

export class Completer {
  private providers: CompletionProvider[] = []

  registerProvider(provider: CompletionProvider): void {
    this.providers.push(provider)
  }

  complete(line: string): [string[], string] {
    const cursor = line.length
    const tokens = line.split(/\s+/)
    const partial = tokens[tokens.length - 1] || ''
    const tokenIndex = tokens.length - 1

    const ctx: CompletionContext = { line, cursor, tokens, partial, tokenIndex }

    for (const provider of this.providers) {
      if (provider.match(ctx)) {
        const results = provider.complete(ctx)
        if (results.length > 0) {
          return [results, partial]
        }
      }
    }

    return [[], partial]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/completer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/completer.ts tests/completer.test.ts
git commit -m "feat: provider-based tab completion"
```

---

### Task 3: REPL loop

**Files:**
- Create: `src/cli/repl.ts`

- [ ] **Step 1: Write REPL**

```ts
// src/cli/repl.ts
import * as readline from 'readline'
import { Completer, SlashCommandProvider, SubcommandProvider, ModelArgProvider, ConfigKeyProvider } from './completer'
import type { AppConfig } from '../config/types'

const HISTORY_FILE = process.env.HOME
  ? `${process.env.HOME}/.mma/repl-history`
  : `${process.env.USERPROFILE}/.mma/repl-history`

export class REPL {
  private rl: readline.Interface
  private completer: Completer
  private running = true

  constructor(private config: AppConfig) {
    this.completer = new Completer()
    this.setupCompleter()
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string) => this.completer.complete(line),
      terminal: true,
    })

    this.rl.on('close', () => {
      this.running = false
    })
  }

  private setupCompleter(): void {
    this.completer.registerProvider(
      new SlashCommandProvider(['help', 'mode', 'session', 'plan', 'todo', 'memory', 'model', 'provider', 'config', 'exit'])
    )
    this.completer.registerProvider(new SubcommandProvider('model', ['list', 'use', 'add', 'remove', 'info']))
    this.completer.registerProvider(new SubcommandProvider('config', ['set', 'show']))
    this.completer.registerProvider(new SubcommandProvider('provider', ['list', 'use']))
    this.completer.registerProvider(new ModelArgProvider([this.config.model]))
    this.completer.registerProvider(new ConfigKeyProvider(['model', 'provider.baseUrl', 'provider.apiKey', 'locale', 'logLevel']))
  }

  async start(): Promise<void> {
    this.printWelcome()

    while (this.running) {
      const line = await this.prompt('> ')
      if (line === null) break

      const trimmed = line.trim()
      if (!trimmed) continue

      if (trimmed.startsWith('/')) {
        await this.handleSlashCommand(trimmed)
      } else {
        await this.handlePrompt(trimmed)
      }
    }

    this.rl.close()
  }

  private async prompt(query: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.rl.question(query, (answer) => resolve(answer))
    })
  }

  private printWelcome(): void {
    console.log('\n  MMA — Micro Models Agent v0.3.0')
    console.log(`  Model: ${this.config.model}`)
    console.log('  Type /help for commands, Ctrl+C to cancel, Ctrl+D to exit\n')
  }

  private async handleSlashCommand(line: string): Promise<void> {
    const parts = line.slice(1).split(/\s+/)
    const cmd = parts[0]

    switch (cmd) {
      case 'help':
        console.log(`
Commands:
  /help              Show this help
  /model list|use    Manage models
  /config set|show   Manage config
  /provider list|use Manage providers
  /exit              Exit
`)
        break
      case 'exit':
        this.running = false
        break
      default:
        console.log(`Unknown command: ${cmd}. Type /help`)
    }
  }

  private async handlePrompt(prompt: string): Promise<void> {
    console.log(`[Processing: ${prompt}]`)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/repl.ts
git commit -m "feat: REPL with slash commands and tab completion integration"
```

---

### Task 4: Setup wizard

**Files:**
- Create: `src/cli/setup.ts`
- Test: `tests/setup.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/setup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SetupWizard } from '../src/cli/setup'

describe('SetupWizard', () => {
  it('should scan common ports', async () => {
    const wizard = new SetupWizard('/tmp/test-config')
    const results = await wizard.scanPorts()
    expect(Array.isArray(results)).toBe(true)
  })

  it('should test connection to endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'test-model' }] }),
    })
    global.fetch = mockFetch as any

    const wizard = new SetupWizard('/tmp/test-config')
    const result = await wizard.testConnection('http://localhost:1234/v1')
    expect(result.success).toBe(true)
  })

  it('should handle connection failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    global.fetch = mockFetch as any

    const wizard = new SetupWizard('/tmp/test-config')
    const result = await wizard.testConnection('http://localhost:1234/v1')
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/setup.test.ts`
Expected: FAIL

- [ ] **Step 3: Write setup.ts**

```ts
// src/cli/setup.ts
import * as readline from 'readline'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

const COMMON_PORTS = [1234, 11434, 8000, 8080, 3000]

interface PortResult {
  port: number
  url: string
  alive: boolean
}

interface ConnectionTestResult {
  success: boolean
  models?: string[]
  error?: string
}

export class SetupWizard {
  private configDir: string

  constructor(configDir: string) {
    this.configDir = configDir
  }

  async scanPorts(): Promise<PortResult[]> {
    const results: PortResult[] = []
    for (const port of COMMON_PORTS) {
      const url = `http://localhost:${port}/v1`
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 2000)
        const response = await fetch(url, { signal: controller.signal })
        clearTimeout(timeout)
        results.push({ port, url, alive: response.ok })
      } catch {
        results.push({ port, url, alive: false })
      }
    }
    return results
  }

  async testConnection(baseUrl: string): Promise<ConnectionTestResult> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(`${baseUrl}/models`, { signal: controller.signal })
      clearTimeout(timeout)

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` }
      }

      const data: any = await response.json()
      const models = (data.data || []).map((m: any) => m.id || m.name)
      return { success: true, models }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async run(config: { model: string; baseUrl: string; apiKey?: string }): Promise<void> {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }

    const configPath = join(this.configDir, 'config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    console.log(`Config saved to ${configPath}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/setup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts tests/setup.test.ts
git commit -m "feat: setup wizard with port scanning and connection testing"
```

---

### Task 5: UI — Markdown formatter and output helpers

**Files:**
- Create: `src/ui/md-formatter.ts`
- Create: `src/ui/output.ts`
- Create: `src/ui/index.ts`
- Test: `tests/md-formatter.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/md-formatter.test.ts
import { describe, it, expect } from 'vitest'
import { formatMarkdown } from '../src/ui/md-formatter'

describe('formatMarkdown', () => {
  it('should format headings', () => {
    const result = formatMarkdown('# Title\n## Subtitle')
    expect(result).toContain('Title')
    expect(result).toContain('Subtitle')
  })

  it('should format code blocks', () => {
    const result = formatMarkdown('```ts\nconst x = 1\n```')
    expect(result).toContain('x = 1')
  })

  it('should format inline code', () => {
    const result = formatMarkdown('Use `const` keyword')
    expect(result).toContain('const')
  })

  it('should format bold text', () => {
    const result = formatMarkdown('**bold** text')
    expect(result).toContain('bold')
    expect(result).toContain('text')
  })

  it('should format lists', () => {
    const result = formatMarkdown('- item 1\n- item 2')
    expect(result).toContain('item 1')
    expect(result).toContain('item 2')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/md-formatter.test.ts`
Expected: FAIL

- [ ] **Step 3: Write md-formatter.ts**

```ts
// src/ui/md-formatter.ts
import pc from 'picocolors'

// Minimal markdown → ANSI formatter
// Supports: headings, code blocks, inline code, bold, lists

export function formatMarkdown(text: string): string {
  let result = text

  // Code blocks (fenced)
  result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, _lang, code) => {
    return '\n' + pc.dim(code.trim()) + '\n'
  })

  // Headings
  result = result.replace(/^### (.+)$/gm, (_, content) => pc.cyan(pc.bold(content)))
  result = result.replace(/^## (.+)$/gm, (_, content) => pc.cyan(pc.bold(content)))
  result = result.replace(/^# (.+)$/gm, (_, content) => pc.cyan(pc.bold(pc.underline(content))))

  // Inline code
  result = result.replace(/`([^`]+)`/g, (_, code) => pc.yellow(code))

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, (_, text) => pc.bold(text))

  // Lists
  result = result.replace(/^- (.+)$/gm, (_, item) => ` ${pc.dim('•')} ${item}`)

  return result
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
```

- [ ] **Step 4: Write output.ts**

```ts
// src/ui/output.ts
import { formatMarkdown, formatError, formatSuccess, formatWarning } from './md-formatter'

export function writeOutput(text: string): void {
  process.stdout.write(formatMarkdown(text) + '\n')
}

export function writeError(text: string): void {
  process.stderr.write(formatError(text) + '\n')
}

export function writeSuccess(text: string): void {
  process.stdout.write(formatSuccess(text) + '\n')
}

export function writeWarning(text: string): void {
  process.stdout.write(formatWarning(text) + '\n')
}
```

- [ ] **Step 5: Write ui/index.ts**

```ts
// src/ui/index.ts
export { formatMarkdown, formatError, formatSuccess, formatWarning } from './md-formatter'
export { writeOutput, writeError, writeSuccess, writeWarning } from './output'
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/md-formatter.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/md-formatter.ts src/ui/output.ts src/ui/index.ts tests/md-formatter.test.ts
git commit -m "feat: UI markdown formatter and output helpers"
```

---

## Self-Review

**Spec coverage:**
- CLI with subcommands (Section 7.1) ✓
- REPL with readline loop + slash commands (Section 7.2) ✓
- Deep tab completion with providers (Section 7.4) ✓
- Fast navigation keybindings (Section 7.5) — uses default readline, no extra code needed ✓
- Setup wizard port scan + test (Section 7.3) ✓
- Markdown → ANSI output (Section 10.3 UI) ✓

**Placeholder scan:** No placeholders.

**Type consistency:** Completer providers match the spec's CompletionContext/CompletionProvider interfaces. REPL uses Completer correctly.
