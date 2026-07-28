# Plan 1: Foundation — Config, Logger, i18n, Core Types, Prompt Builder

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational layer that all other subsystems depend on — config loading/merging, structured logging, i18n for user messages, core shared types, and the prompt builder.

**Architecture:** Single-responsibility modules with no circular dependencies. Config uses 3-layer merge (defaults → global → project + env overrides). Logger wraps console with levels. i18n provides a `t()` function from JSON dictionaries. PromptBuilder collects `PromptBlock[]` from modules, sorts by priority, and fits within a token budget.

**Tech Stack:** Bun + TypeScript, vitest, picocolors (for logger if needed)

---

## File Structure

```
src/
├── config/
│   ├── types.ts        — AppConfig, ProviderConfig, OrchestratorConfig, ContextBudget
│   ├── defaults.ts      — DEFAULTS object (single source of truth)
│   ├── config.ts        — loadConfig() with 3-layer merge + env overrides
│   └── index.ts         — re-exports
├── logger/
│   ├── app-logger.ts    — Logger class with debug/info/warn/error
│   └── index.ts
├── i18n/
│   ├── en.json          — English translations
│   ├── ru.json          — Russian translations
│   └── index.ts         — t() function, setLocale()
├── core/
│   ├── types.ts         — AgentContext, PromptBlock, LLMResponse, ToolCall, ToolResult, AgentState
│   ├── prompt-builder.ts — PromptBuilder: collect, sort, fit budget
│   └── index.ts
└── index.ts             — re-exports everything from config, logger, i18n, core
```

Tests:
```
tests/
├── config.test.ts
├── logger.test.ts
├── i18n.test.ts
└── prompt-builder.test.ts
```

---

### Task 1: Config types + defaults

**Files:**
- Create: `src/config/types.ts`
- Create: `src/config/defaults.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../src/config/defaults'

describe('config defaults', () => {
  it('should have all required fields', () => {
    expect(DEFAULTS.model).toBe('qwen3.5-9b')
    expect(DEFAULTS.provider.type).toBe('openai-compat')
    expect(DEFAULTS.provider.baseUrl).toBe('http://localhost:1234/v1')
    expect(DEFAULTS.provider.apiKey).toBe('not-needed')
    expect(DEFAULTS.contextWindow).toBe(32768)
    expect(DEFAULTS.maxToolIterations).toBe(25)
    expect(DEFAULTS.stuckThreshold).toBe(8)
    expect(DEFAULTS.autoPlan).toBe(true)
    expect(DEFAULTS.logLevel).toBe('info')
    expect(DEFAULTS.locale).toBe('en')
  })

  it('should have context budget defaults', () => {
    expect(DEFAULTS.contextBudget.systemPrompt).toBe(0.25)
    expect(DEFAULTS.contextBudget.responseReserve).toBe(0.12)
    expect(DEFAULTS.contextBudget.compactionThreshold).toBe(0.75)
  })

  it('should have orchestrator undefined by default', () => {
    expect(DEFAULTS.orchestrator.model).toBeUndefined()
    expect(DEFAULTS.orchestrator.provider).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write types.ts**

```ts
// src/config/types.ts

export interface ProviderConfig {
  type: string
  baseUrl: string
  apiKey?: string
}

export interface OrchestratorConfig {
  model?: string
  provider?: ProviderConfig
}

export interface ContextBudget {
  systemPrompt: number
  responseReserve: number
  compactionThreshold: number
}

export interface AppConfig {
  model: string
  provider: ProviderConfig
  orchestrator: OrchestratorConfig
  contextWindow: number
  contextBudget: ContextBudget
  maxToolIterations: number
  stuckThreshold: number
  autoPlan: boolean
  logLevel: string
  locale: string
}
```

- [ ] **Step 4: Write defaults.ts**

```ts
// src/config/defaults.ts
import type { AppConfig } from './types'

export const DEFAULTS: AppConfig = {
  model: 'qwen3.5-9b',
  provider: {
    type: 'openai-compat',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
  },
  orchestrator: {
    model: undefined,
    provider: undefined,
  },
  contextWindow: 32768,
  contextBudget: {
    systemPrompt: 0.25,
    responseReserve: 0.12,
    compactionThreshold: 0.75,
  },
  maxToolIterations: 25,
  stuckThreshold: 8,
  autoPlan: true,
  logLevel: 'info',
  locale: 'en',
}
```

- [ ] **Step 5: Write config/index.ts**

```ts
// src/config/index.ts
export { DEFAULTS } from './defaults'
export { loadConfig } from './config'
export type { AppConfig, ProviderConfig, OrchestratorConfig, ContextBudget } from './types'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts src/config/index.ts tests/config.test.ts
git commit -m "feat: config types and defaults"
```

---

### Task 2: Config loader (3-layer merge + env overrides)

**Files:**
- Create: `src/config/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// add to tests/config.test.ts
import { loadConfig } from '../src/config/config'
import { mkdtempSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('loadConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-test-'))
  })

  it('should return defaults when no files exist', () => {
    const cfg = loadConfig({ 
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, '.mmrc') 
    })
    expect(cfg.model).toBe('qwen3.5-9b')
  })

  it('should merge global config', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ model: 'test-model' }))
    const cfg = loadConfig({ 
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, '.mmrc') 
    })
    expect(cfg.model).toBe('test-model')
    expect(cfg.provider.baseUrl).toBe('http://localhost:1234/v1') // from defaults
  })

  it('should merge project .mmrc over global', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ model: 'global-model' }))
    writeFileSync(join(tmpDir, '.mmrc'), JSON.stringify({ model: 'project-model' }))
    const cfg = loadConfig({ 
      configDir: tmpDir,
      projectConfigPath: join(tmpDir, '.mmrc') 
    })
    expect(cfg.model).toBe('project-model')
  })

  it('should apply MMA_ env vars', () => {
    const prev = process.env.MMA_MODEL
    process.env.MMA_MODEL = 'env-model'
    try {
      const cfg = loadConfig({ 
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, '.mmrc') 
      })
      expect(cfg.model).toBe('env-model')
    } finally {
      if (prev) process.env.MMA_MODEL = prev
      else delete process.env.MMA_MODEL
    }
  })

  it('should handle MMA_PROVIDER_BASEURL env var', () => {
    const prev = process.env.MMA_PROVIDER_BASEURL
    process.env.MMA_PROVIDER_BASEURL = 'http://env:8080/v1'
    try {
      const cfg = loadConfig({ 
        configDir: tmpDir,
        projectConfigPath: join(tmpDir, '.mmrc') 
      })
      expect(cfg.provider.baseUrl).toBe('http://env:8080/v1')
    } finally {
      if (prev) process.env.MMA_PROVIDER_BASEURL = prev
      else delete process.env.MMA_PROVIDER_BASEURL
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — loadConfig not exported

- [ ] **Step 3: Write config.ts**

```ts
// src/config/config.ts
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULTS } from './defaults'
import type { AppConfig } from './types'

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key of Object.keys(source as object)) {
    const k = key as keyof T
    const srcVal = source[k]
    const tgtVal = target[k]
    if (
      srcVal !== null && srcVal !== undefined &&
      typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[k] = deepMerge(tgtVal as any, srcVal as any)
    } else if (srcVal !== undefined) {
      result[k] = srcVal
    }
  }
  return result
}

function loadJSON(path: string): Record<string, unknown> | null {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch { /* ignore malformed files */ }
  return null
}

function applyEnvVars(config: AppConfig): AppConfig {
  const env = process.env
  const result = { ...config }

  if (env.MMA_MODEL) result.model = env.MMA_MODEL
  if (env.MMA_PROVIDER_TYPE) result.provider = { ...result.provider, type: env.MMA_PROVIDER_TYPE }
  if (env.MMA_PROVIDER_BASEURL) result.provider = { ...result.provider, baseUrl: env.MMA_PROVIDER_BASEURL }
  if (env.MMA_PROVIDER_APIKEY) result.provider = { ...result.provider, apiKey: env.MMA_PROVIDER_APIKEY }
  if (env.MMA_LOG_LEVEL) result.logLevel = env.MMA_LOG_LEVEL
  if (env.MMA_LOCALE) result.locale = env.MMA_LOCALE
  if (env.MMA_CONTEXT_WINDOW) result.contextWindow = parseInt(env.MMA_CONTEXT_WINDOW, 10)
  if (env.MMA_MAX_TOOL_ITERATIONS) result.maxToolIterations = parseInt(env.MMA_MAX_TOOL_ITERATIONS, 10)
  if (env.MMA_STUCK_THRESHOLD) result.stuckThreshold = parseInt(env.MMA_STUCK_THRESHOLD, 10)
  if (env.MMA_AUTO_PLAN) result.autoPlan = env.MMA_AUTO_PLAN === 'true'

  return result
}

export interface LoadConfigOptions {
  configDir: string
  projectConfigPath: string
}

export function loadConfig(options: LoadConfigOptions): AppConfig {
  const globalPath = join(options.configDir, 'config.json')
  const projectPath = options.projectConfigPath

  let config: AppConfig = { ...DEFAULTS }

  const globalData = loadJSON(globalPath)
  if (globalData) {
    config = deepMerge(config, globalData as Partial<AppConfig>)
  }

  const projectData = loadJSON(projectPath)
  if (projectData) {
    config = deepMerge(config, projectData as Partial<AppConfig>)
  }

  config = applyEnvVars(config)

  return config
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/config.ts tests/config.test.ts
git commit -m "feat: config loader with 3-layer merge and env vars"
```

---

### Task 3: Logger

**Files:**
- Create: `src/logger/app-logger.ts`
- Create: `src/logger/index.ts`
- Test: `tests/logger.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/logger.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Logger } from '../src/logger/app-logger'

describe('Logger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('should log messages at correct level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = new Logger('debug')

    logger.debug('debug msg')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'))

    logger.info('info msg')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'))

    logger.warn('warn msg')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[WARN]'))

    logger.error('error msg')
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'))
  })

  it('should filter by log level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = new Logger('warn')

    logger.debug('debug msg')
    logger.info('info msg')
    expect(spy).not.toHaveBeenCalled()

    logger.warn('warn msg')
    expect(spy).toHaveBeenCalled()
  })

  it('should format message with metadata', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = new Logger('info')

    logger.info('test', { key: 'value' })
    const call = spy.mock.calls[0][0] as string
    expect(call).toContain('[INFO]')
    expect(call).toContain('test')
    expect(call).toContain('key')
  })

  it('should set level dynamically', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = new Logger('error')

    logger.setLevel('info')
    logger.info('now visible')
    expect(spy).toHaveBeenCalled()
  })

  it('should create child logger with prefix', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = new Logger('info')
    const child = logger.child('tools')

    child.info('hello')
    const call = spy.mock.calls[0][0] as string
    expect(call).toContain('[tools]')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/logger.test.ts`
Expected: FAIL

- [ ] **Step 3: Write app-logger.ts**

```ts
// src/logger/app-logger.ts

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LEVELS

export class Logger {
  private level: LogLevel
  private prefix: string

  constructor(level: LogLevel = 'info', prefix = '') {
    this.level = level
    this.prefix = prefix
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  child(prefix: string): Logger {
    const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix
    return new Logger(this.level, childPrefix)
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log('debug', msg, meta)
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.log('info', msg, meta)
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log('warn', msg, meta)
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.log('error', msg, meta)
  }

  private log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return

    const ts = new Date().toISOString()
    const prefix = this.prefix ? ` [${this.prefix}]` : ''
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''

    console.log(`[${level.toUpperCase()}]${prefix} ${ts} — ${msg}${metaStr}`)
  }
}
```

- [ ] **Step 4: Write logger/index.ts**

```ts
// src/logger/index.ts
export { Logger } from './app-logger'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/logger.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/logger/app-logger.ts src/logger/index.ts tests/logger.test.ts
git commit -m "feat: structured logger with levels and child loggers"
```

---

### Task 4: i18n

**Files:**
- Create: `src/i18n/en.json`
- Create: `src/i18n/ru.json`
- Create: `src/i18n/index.ts`
- Test: `tests/i18n.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/i18n.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { t, setLocale, loadLocale } from '../src/i18n/index'

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en')
  })

  it('should return key for unknown translation', () => {
    expect(t('unknown.key')).toBe('unknown.key')
  })

  it('should translate simple string', () => {
    const result = t('file.created', { path: 'src/index.ts' })
    expect(result).toContain('Created')
    expect(result).toContain('src/index.ts')
  })

  it('should support Russian locale', () => {
    setLocale('ru')
    const result = t('file.created', { path: 'src/index.ts' })
    expect(result).toContain('Создан')
    expect(result).toContain('src/index.ts')
  })

  it('should handle error messages', () => {
    expect(t('error.timeout')).toBe('Request timed out')
  })

  it('should fallback to en when locale missing key', () => {
    setLocale('ru')
    // use a key that exists in en but maybe not in ru
    const result = t('session.started', { id: 'abc' })
    expect(result).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/i18n.test.ts`
Expected: FAIL

- [ ] **Step 3: Write en.json**

```json
{
  "file.created": "Created {path}",
  "file.deleted": "Deleted {path}",
  "file.updated": "Updated {path}",
  "error.timeout": "Request timed out",
  "error.unknown": "An unknown error occurred",
  "error.notfound": "Not found: {path}",
  "session.started": "Session started: {id}",
  "session.ended": "Session ended: {id}",
  "tool.executed": "Executed {name}",
  "tool.failed": "Tool {name} failed: {error}",
  "plan.created": "Plan created: {title} ({steps} steps)",
  "plan.step.done": "Step {n}/{total}: {description} ✓",
  "plan.complete": "Task complete: {summary}"
}
```

- [ ] **Step 4: Write ru.json**

```json
{
  "file.created": "Создан {path}",
  "file.deleted": "Удалён {path}",
  "file.updated": "Обновлён {path}",
  "error.timeout": "Таймаут запроса",
  "error.unknown": "Неизвестная ошибка",
  "error.notfound": "Не найдено: {path}",
  "session.started": "Сессия начата: {id}",
  "session.ended": "Сессия завершена: {id}",
  "tool.executed": "Выполнен {name}",
  "tool.failed": "Инструмент {name} упал: {error}",
  "plan.created": "План создан: {title} ({steps} шагов)",
  "plan.step.done": "Шаг {n}/{total}: {description} ✓",
  "plan.complete": "Задача выполнена: {summary}"
}
```

- [ ] **Step 5: Write i18n/index.ts**

```ts
// src/i18n/index.ts
import en from './en.json'
import ru from './ru.json'

const locales: Record<string, Record<string, string>> = { en, ru }

let currentLocale = 'en'

function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  let result: Record<string, string> = {}
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof val === 'string') {
      result[fullKey] = val
    } else if (typeof val === 'object' && val !== null) {
      result = { ...result, ...flatten(val as Record<string, unknown>, fullKey) }
    }
  }
  return result
}

const flat: Record<string, Record<string, string>> = {}

for (const [name, dict] of Object.entries(locales)) {
  flat[name] = flatten(dict)
}

export function setLocale(locale: string): void {
  if (flat[locale]) {
    currentLocale = locale
  }
}

export function loadLocale(name: string, dict: Record<string, unknown>): void {
  locales[name] = dict as any
  flat[name] = flatten(dict)
}

export function t(key: string, params?: Record<string, string | number>): string {
  const localeDict = flat[currentLocale]
  const enDict = flat['en']
  let template = localeDict?.[key] || enDict?.[key]

  if (!template) return key

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      template = template.replace(`{${k}}`, String(v))
    }
  }

  return template
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/i18n.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/i18n/en.json src/i18n/ru.json src/i18n/index.ts tests/i18n.test.ts
git commit -m "feat: i18n with en/ru locales and template interpolation"
```

---

### Task 5: Core types

**Files:**
- Create: `src/core/types.ts`

- [ ] **Step 1: Write types.ts directly (type-only file, no behavior to test)**

```ts
// src/core/types.ts

export type AgentState = 'INIT' | 'THINK' | 'ACT' | 'OBSERVE' | 'OUTPUT' | 'ERROR'

export interface PromptBlock {
  content: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  essential: boolean
  estimatedTokens: number
}

export type ToolCallStatus = 'done' | 'failed' | 'skipped'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  success: boolean
  output: string
  toolCallId?: string
}

export type LLMResponse =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; calls: ToolCall[] }
  | { type: 'reasoning'; content: string }

export interface AgentContext {
  state: AgentState
  config: import('../config/types').AppConfig
  messages: Array<{ role: string; content: string }>
  toolResults: ToolResult[]
  iterationCount: number
  currentStep?: number
  totalSteps?: number
}

export interface AgentModule {
  name: string
  getSystemPromptBlock?(): PromptBlock | null
  getToolDefinitions?(): import('../tools/types').ToolDefinition[]
  getPlugin?(): import('../modules/plugins/types').AgentPlugin
}

export interface HallucinationResult {
  status: 'pass' | 'warn' | 'retry' | 'block'
  reason?: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: core types for agent loop, prompt, tools, and modules"
```

---

### Task 6: Prompt Builder

**Files:**
- Create: `src/core/prompt-builder.ts`
- Create: `src/core/index.ts`
- Test: `tests/prompt-builder.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/prompt-builder.test.ts
import { describe, it, expect } from 'vitest'
import { PromptBuilder } from '../src/core/prompt-builder'
import type { PromptBlock } from '../src/core/types'

describe('PromptBuilder', () => {
  it('should include essential blocks regardless of budget', () => {
    const builder = new PromptBuilder(100)
    builder.addBlock({ content: 'A'.repeat(60), priority: 'critical', essential: true, estimatedTokens: 60 })
    builder.addBlock({ content: 'B'.repeat(60), priority: 'normal', essential: false, estimatedTokens: 60 })
    const result = builder.build()
    expect(result.prompt).toContain('A'.repeat(60))
    expect(result.prompt).not.toContain('B'.repeat(60))
  })

  it('should sort by priority', () => {
    const builder = new PromptBuilder(1000)
    builder.addBlock({ content: 'low', priority: 'low', essential: false, estimatedTokens: 5 })
    builder.addBlock({ content: 'high', priority: 'high', essential: false, estimatedTokens: 5 })
    builder.addBlock({ content: 'critical', priority: 'critical', essential: true, estimatedTokens: 5 })
    const result = builder.build()
    const idxCritical = result.prompt.indexOf('critical')
    const idxHigh = result.prompt.indexOf('high')
    const idxLow = result.prompt.indexOf('low')
    expect(idxCritical).toBeLessThan(idxHigh)
    expect(idxHigh).toBeLessThan(idxLow)
  })

  it('should report excluded blocks', () => {
    const builder = new PromptBuilder(50)
    builder.addBlock({ content: 'essential', priority: 'critical', essential: true, estimatedTokens: 30 })
    builder.addBlock({ content: 'excluded-me', priority: 'low', essential: false, estimatedTokens: 100 })
    const result = builder.build()
    expect(result.excluded).toHaveLength(1)
    expect(result.excluded[0]).toBe('excluded-me')
  })

  it('should fit blocks within token budget', () => {
    const builder = new PromptBuilder(50)
    builder.addBlock({ content: 'A', priority: 'normal', essential: false, estimatedTokens: 30 })
    builder.addBlock({ content: 'B', priority: 'low', essential: false, estimatedTokens: 30 })
    const result = builder.build()
    expect(result.excluded).toHaveLength(1)
  })

  it('should handle empty builder', () => {
    const builder = new PromptBuilder(100)
    const result = builder.build()
    expect(result.prompt).toBe('')
    expect(result.excluded).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/prompt-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Write prompt-builder.ts**

```ts
// src/core/prompt-builder.ts
import type { PromptBlock } from './types'

export interface BuildResult {
  prompt: string
  excluded: string[]
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export class PromptBuilder {
  private blocks: PromptBlock[] = []
  private budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  addBlock(block: PromptBlock): void {
    this.blocks.push(block)
  }

  addBlocks(blocks: PromptBlock[]): void {
    for (const b of blocks) {
      this.blocks.push(b)
    }
  }

  build(): BuildResult {
    const essential: PromptBlock[] = []
    const nonEssential: PromptBlock[] = []

    for (const block of this.blocks) {
      if (block.essential) {
        essential.push(block)
      } else {
        nonEssential.push(block)
      }
    }

    nonEssential.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    )

    let usedTokens = 0
    const included: string[] = []
    const excluded: string[] = []

    for (const block of [...essential, ...nonEssential]) {
      const tokens = block.estimatedTokens
      if (usedTokens + tokens <= this.budget) {
        included.push(block.content)
        usedTokens += tokens
      } else if (!block.essential) {
        excluded.push(block.content)
      }
    }

    return {
      prompt: included.join('\n\n'),
      excluded,
    }
  }
}
```

- [ ] **Step 4: Write core/index.ts**

```ts
// src/core/index.ts
export { PromptBuilder } from './prompt-builder'
export type {
  AgentState, PromptBlock, ToolCall, ToolResult,
  LLMResponse, AgentContext, AgentModule, HallucinationResult,
} from './types'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/prompt-builder.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/prompt-builder.ts src/core/index.ts tests/prompt-builder.test.ts
git commit -m "feat: prompt builder with priority sorting and token budget"
```

---

### Task 7: Entry point re-exports

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Write src/index.ts**

```ts
// src/index.ts
export * from './config/index'
export * from './logger/index'
export * from './core/index'
```

- [ ] **Step 2: Quick verification**

Run: `bun --eval "import('./src/index.ts').then(m => console.log(Object.keys(m).length))"`
Expected: prints a number (no crash)

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: main entry point re-exports"
```

---

## Self-Review

**Spec coverage:**
- Config types + defaults + 3-layer merge (Section 8 of design doc) ✓
- Logger (Section 10.1 App Logger) ✓
- i18n for user-facing messages (Section 9) ✓
- Core types: AgentContext, PromptBlock, AgentState, ToolCall, ToolResult, LLMResponse (Section 3, 4.3, 6) ✓
- PromptBuilder with priority + token budget (Section 3.2) ✓

**Placeholder scan:** No placeholders found.

**Type consistency:** All types used in prompt-builder match core/types.ts. Config types match defaults.ts.
