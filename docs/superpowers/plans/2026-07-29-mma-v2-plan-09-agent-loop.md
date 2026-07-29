# Plan 09: Agent Loop Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the central state machine (`core/agent.ts`) that connects CLI → LLM → Tools → Modules, and wire it to the CLI so `bun run mma "prompt"` actually runs through the agent loop.

**Architecture:** A single `Agent` class in `core/agent.ts` with a KISS state machine (INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR). All heavy lifting is delegated to existing components (LLMProvider, ToolExecutor, PluginManager, ContextManager, HallucinationDetector, PromptBuilder). A `bootstrap()` function in `core/bootstrap.ts` wires all dependencies. CLI `main.ts` calls bootstrap + agent when args provided.

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure

```
src/core/
  agent.ts        — NEW: Agent class with state machine loop (<200 lines)
  bootstrap.ts    — NEW: Dependency wiring, module registration, Agent factory

src/cli/
  main.ts         — MODIFY: Wire agent path when prompt args given

src/modules/plugins/
  manager.ts      — MODIFY: Add runOnBeforeThink() support

tests/
  core/
    agent.test.ts — NEW: Agent loop unit tests
    bootstrap.test.ts — NEW: Bootstrap wiring test
```

### Task 1: Add `runOnBeforeThink` to PluginManager

**Files:**
- Modify: `src/modules/plugins/manager.ts`
- Test: covered by existing plugin tests + agent tests

- [ ] **Step 1: Add method to PluginManager**

```typescript
// src/modules/plugins/manager.ts — add after runOnSessionEnd

  runOnBeforeThink(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onBeforeThink) {
        try { plugin.onBeforeThink(ctx) }
        catch { /* error isolation */ }
      }
    }
  }
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `bun test`
Expected: 180 pass, 0 fail

- [ ] **Step 3: Commit**

```bash
git add src/modules/plugins/manager.ts
git commit -m "feat: add runOnBeforeThink to PluginManager"
```

---

### Task 2: Write agent.test.ts (TDD)

**Files:**
- Create: `tests/core/agent.test.ts`

- [ ] **Step 1: Write failing tests for Agent class**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { Agent } from '../../src/core/agent'
import type { AppConfig } from '../../src/config/types'

function createMockDeps(overrides?: Record<string, unknown>) {
  const mockProvider = {
    model: 'test-model',
    contextWindow: 4096,
    chat: vi.fn().mockReturnValue((async function* () {
      yield { type: 'text' as const, content: 'Hello from mock LLM' }
      yield { type: 'done' as const, finishReason: 'stop' as const }
    })()),
    countTokens: vi.fn().mockReturnValue(10),
  }

  const mockToolExecutor = {
    execute: vi.fn().mockResolvedValue({ success: true, output: 'tool ok' }),
  }

  const mockPluginManager = {
    getAllPlugins: vi.fn().mockReturnValue([]),
    runOnBeforeThink: vi.fn(),
    runOnBeforeTool: vi.fn().mockResolvedValue(true),
    runOnAfterTool: vi.fn(),
    runOnError: vi.fn(),
    runOnSessionStart: vi.fn(),
    runOnSessionEnd: vi.fn(),
  }

  const mockContextManager = {
    addMessage: vi.fn(),
    getMessageCount: vi.fn().mockReturnValue(0),
    needsCompaction: vi.fn().mockReturnValue(false),
    compact: vi.fn(),
    getActiveHistory: vi.fn().mockReturnValue([]),
  }

  const mockHallucinationDetector = {
    validate: vi.fn().mockReturnValue({ status: 'pass' as const }),
  }

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const config: AppConfig = {
    version: '2.0.0',
    model: 'test-model',
    provider: { type: 'openai-compat', baseUrl: 'http://localhost:1234/v1' },
    orchestrator: {},
    contextWindow: 4096,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    maxToolIterations: 5,
    stuckThreshold: 8,
    autoPlan: true,
    logLevel: 'info',
    locale: 'en',
  }

  return {
    config,
    llmProvider: mockProvider,
    toolExecutor: mockToolExecutor,
    pluginManager: mockPluginManager,
    contextManager: mockContextManager,
    hallucinationDetector: mockHallucinationDetector,
    logger: mockLogger,
    baseDir: '/tmp',
    promptBlocks: [],
    ...overrides,
  }
}

describe('Agent', () => {
  it('returns text response for simple text LLM output', async () => {
    const deps = createMockDeps()
    const agent = new Agent(deps as any)
    const result = await agent.run('hello')
    expect(result.text).toBe('Hello from mock LLM')
    expect(result.success).toBe(true)
  })

  it('executes tool calls and continues loop', async () => {
    const mockProvider = {
      model: 'test-model',
      contextWindow: 4096,
      chat: vi.fn()
        .mockReturnValueOnce((async function* () {
          yield { type: 'tool_call' as const, toolCall: { id: 'call-1', name: 'test_tool', arguments: '{}' } }
          yield { type: 'done' as const, finishReason: 'tool_calls' as const }
        })())
        .mockReturnValueOnce((async function* () {
          yield { type: 'text' as const, content: 'Done after tool' }
          yield { type: 'done' as const, finishReason: 'stop' as const }
        })()),
      countTokens: vi.fn().mockReturnValue(10),
    }

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: 'tool executed', toolCallId: 'call-1' }),
    }

    const deps = createMockDeps({ llmProvider: mockProvider as any, toolExecutor: mockExecutor as any })
    const agent = new Agent(deps as any)
    const result = await agent.run('do something')
    expect(result.text).toBe('Done after tool')
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1)
  })

  it('limits max iterations and returns partial result', async () => {
    const mockProvider = {
      model: 'test-model',
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue((async function* () {
        yield { type: 'tool_call' as const, toolCall: { id: 'call-x', name: 'test_tool', arguments: '{}' } }
        yield { type: 'done' as const, finishReason: 'tool_calls' as const }
      })()),
      countTokens: vi.fn().mockReturnValue(10),
    }

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: 'tool ok', toolCallId: 'call-x' }),
    }

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      config: { ...createMockDeps().config, maxToolIterations: 2 },
    })
    const agent = new Agent(deps as any)
    const result = await agent.run('loop forever')
    expect(result.success).toBe(false)
    expect(result.error).toContain('iteration')
  })

  it('hallucination block prevents tool execution', async () => {
    const mockProvider = {
      model: 'test-model',
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue((async function* () {
        yield { type: 'text' as const, content: 'I will delete everything' }
        yield { type: 'done' as const, finishReason: 'stop' as const }
      })()),
      countTokens: vi.fn().mockReturnValue(10),
    }

    const detector = {
      validate: vi.fn().mockReturnValue({ status: 'block' as const, reason: 'Dangerous action detected' }),
    }

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      hallucinationDetector: detector as any,
    })
    const agent = new Agent(deps as any)
    const result = await agent.run('delete everything')
    expect(result.success).toBe(false)
    expect(result.error).toContain('blocked')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/agent.test.ts`
Expected: 4 fail (Agent class not found, module errors)

---

### Task 3: Implement Agent class

**Files:**
- Create: `src/core/agent.ts`

- [ ] **Step 1: Write Agent class**

```typescript
import type { LLMProvider } from '../llm/provider'
import type { ToolExecutor } from '../tools/executor'
import type { PluginManager } from '../modules/plugins/manager'
import type { ContextManager } from '../modules/context/manager'
import type { HallucinationDetector } from '../modules/hallucination/detector'
import type { Logger } from '../logger/app-logger'
import type { AppConfig } from '../config/types'
import type { PromptBlock } from './types'
import type { ToolCall } from './types'
import { PromptBuilder } from './prompt-builder'

export interface AgentDeps {
  config: AppConfig
  llmProvider: LLMProvider
  toolExecutor: ToolExecutor
  pluginManager: PluginManager
  contextManager: ContextManager
  hallucinationDetector: HallucinationDetector
  logger: Logger
  baseDir: string
  promptBlocks: PromptBlock[]
}

export interface AgentResult {
  success: boolean
  text: string
  error?: string
  iterationCount: number
}

export class Agent {
  private deps: AgentDeps

  constructor(deps: AgentDeps) {
    this.deps = deps
  }

  async run(input: string): Promise<AgentResult> {
    const { config, llmProvider, toolExecutor, pluginManager, contextManager, hallucinationDetector, logger, promptBlocks } = this.deps

    const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt)
    const builder = new PromptBuilder(systemBudget)
    builder.addBlocks(promptBlocks)
    const { prompt: systemPrompt } = builder.build()

    contextManager.addMessage({ role: 'system', content: systemPrompt })
    contextManager.addMessage({ role: 'user', content: input })

    let iteration = 0
    let lastText = ''

    while (iteration < config.maxToolIterations) {
      iteration++

      pluginManager.runOnBeforeThink({ iteration, logger })

      if (contextManager.needsCompaction()) {
        contextManager.compact()
        logger.debug('Context compacted')
      }

      const history = contextManager.getActiveHistory()

      let textContent = ''
      let reasoningContent = ''
      const toolCalls: ToolCall[] = []
      let sawToolCall = false

      try {
        for await (const chunk of llmProvider.chat(history)) {
          if (chunk.type === 'text' && chunk.content) {
            textContent += chunk.content
          }
          if (chunk.type === 'reasoning' && chunk.content) {
            reasoningContent += chunk.content
          }
          if (chunk.type === 'tool_call' && chunk.toolCall) {
            sawToolCall = true
            let parsedArgs: Record<string, unknown>
            try {
              parsedArgs = JSON.parse(chunk.toolCall.arguments)
            } catch {
              parsedArgs = {}
            }
            toolCalls.push({
              id: chunk.toolCall.id,
              name: chunk.toolCall.name,
              arguments: parsedArgs,
            })
          }
        }
      } catch (err: any) {
        logger.error(`LLM call failed: ${err.message}`)
        pluginManager.runOnError({ iteration, logger }, err)
        return { success: false, text: lastText, error: `LLM error: ${err.message}`, iterationCount: iteration }
      }

      if (sawToolCall) {
        for (const call of toolCalls) {
          const proceed = await pluginManager.runOnBeforeTool({ iteration, logger }, call)
          if (!proceed) {
            logger.warn(`Tool call blocked by plugin: ${call.name}`)
            contextManager.addMessage({
              role: 'tool',
              content: `Tool ${call.name} was blocked by policy`,
              name: call.name,
            })
            continue
          }

          const result = await toolExecutor.execute(call)
          contextManager.addMessage({
            role: 'tool',
            content: result.output,
            name: call.name,
          })
        }
        continue
      }

      const hallucinationResult = hallucinationDetector.validate(textContent)
      if (hallucinationResult.status === 'block') {
        logger.warn(`Response blocked: ${hallucinationResult.reason}`)
        return { success: false, text: lastText, error: `Response blocked: ${hallucinationResult.reason}`, iterationCount: iteration }
      }

      if (textContent || reasoningContent) {
        contextManager.addMessage({ role: 'assistant', content: textContent || reasoningContent })
      }

      lastText = textContent

      if (!sawToolCall) {
        break
      }
    }

    if (iteration >= config.maxToolIterations) {
      return { success: false, text: lastText, error: `Max iterations (${config.maxToolIterations}) reached`, iterationCount: iteration }
    }

    return { success: true, text: lastText, iterationCount: iteration }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/core/agent.test.ts`
Expected: 4 pass

- [ ] **Step 3: Commit**

```bash
git add src/core/agent.ts tests/core/agent.test.ts
git commit -m "feat: implement Agent state machine loop"
```

---

### Task 4: Add Agent to core barrel

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add Agent export**

```typescript
export { PromptBuilder } from './prompt-builder'
export { Agent } from './agent'
export type { AgentDeps, AgentResult } from './agent'
export type { AgentModule } from '../modules/types'
export type {
  AgentState, PromptBlock, ToolCall, ToolResult,
  LLMResponse, AgentContext, HallucinationResult,
} from './types'
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts
git commit -m "chore: export Agent from core barrel"
```

---

### Task 5: Write bootstrap function

**Files:**
- Create: `src/core/bootstrap.ts`

- [ ] **Step 1: Write bootstrap.ts**

```typescript
import { loadConfig } from '../config/config'
import { DEFAULTS } from '../config/defaults'
import { Logger } from '../logger/app-logger'
import { OpenAICompatProvider } from '../llm/openai-compat'
import { ToolRegistry, registerAllTools } from '../tools/index'
import { ToolExecutor } from '../tools/executor'
import { ModuleRegistry } from '../modules/registry'
import { PluginManager } from '../modules/plugins/manager'
import { ContextManager } from '../modules/context/manager'
import { HallucinationDetector } from '../modules/hallucination/detector'
import { ExecutionModule } from '../modules/execution/module'
import { Agent } from './agent'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentDeps } from './agent'
import type { ToolContext } from '../tools/types'
import type { PromptBlock } from './types'
import type { AppConfig } from '../config/types'

export interface BootstrapResult {
  agent: Agent
  config: AppConfig
  logger: Logger
}

export function bootstrap(configDir?: string, projectDir?: string): BootstrapResult {
  const dir = configDir || join(homedir(), '.mma')
  const projectConfigPath = projectDir ? join(projectDir, '.mmarc.json') : join(process.cwd(), '.mmarc.json')

  const config = loadConfig({ configDir: dir, projectConfigPath })

  const logger = new Logger(config.logLevel as any)

  const llmProvider = new OpenAICompatProvider({
    model: config.model,
    baseUrl: config.provider.baseUrl,
    apiKey: config.provider.apiKey,
    contextWindow: config.contextWindow,
  })

  const toolRegistry = new ToolRegistry()
  registerAllTools(toolRegistry)

  const pluginManager = new PluginManager()

  const baseDir = projectDir || process.cwd()

  const toolCtx: ToolContext = {
    config,
    baseDir,
    logger,
  }

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager)

  const contextManager = new ContextManager(config.contextWindow)

  const hallucinationDetector = new HallucinationDetector()

  const moduleRegistry = new ModuleRegistry()

  const execModule = new ExecutionModule(baseDir, config.stuckThreshold)
  moduleRegistry.register(execModule)

  const plugin = execModule.getPlugin()
  if (plugin) {
    pluginManager.register(plugin)
  }

  const promptBlocks: PromptBlock[] = moduleRegistry.collectPromptBlocks()

  const agentDeps: AgentDeps = {
    config,
    llmProvider,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    logger,
    baseDir,
    promptBlocks,
  }

  const agent = new Agent(agentDeps)

  return { agent, config, logger }
}
```

- [ ] **Step 2: Write bootstrap test**

```typescript
// tests/core/bootstrap.test.ts
import { describe, it, expect } from 'vitest'
import { bootstrap } from '../../src/core/bootstrap'
import * as path from 'path'

describe('bootstrap', () => {
  it('creates agent with valid config', () => {
    const result = bootstrap(
      path.join(process.cwd(), 'test', 'fixtures', 'config'),
      process.cwd()
    )
    expect(result.agent).toBeDefined()
    expect(result.config).toBeDefined()
    expect(result.logger).toBeDefined()
  })

  it('uses defaults when no config found', () => {
    const result = bootstrap('/nonexistent/mma-config')
    expect(result.agent).toBeDefined()
    expect(result.config.model).toBe('qwen3.5-9b')
  })
})
```

Run: `bun test tests/core/bootstrap.test.ts`
Expected: 2 pass (or 1 fail if config dir doesn't exist — adjust test accordingly)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/core/bootstrap.ts tests/core/bootstrap.test.ts
git commit -m "feat: add bootstrap function to wire agent dependencies"
```

---

### Task 6: Wire agent to CLI

**Files:**
- Modify: `src/cli/main.ts`

- [ ] **Step 1: Add agent execution path to main.ts**

```typescript
import { createProgram } from './commands'
import { bootstrap } from '../core/bootstrap'
import { Repl } from './repl'

async function main(): Promise<void> {
  const program = createProgram()
  program.parse(process.argv)

  const args = program.args

  if (args.length > 0) {
    const { agent, logger } = bootstrap()
    const result = await agent.run(args.join(' '))
    if (result.success) {
      console.log(result.text)
    } else {
      console.error(`Error: ${result.error}`)
      if (result.text) {
        console.log(`Partial output:\n${result.text}`)
      }
      process.exit(1)
    }
  } else {
    const repl = new Repl()
    repl.start()
  }
}

main()
```

- [ ] **Step 2: Run smoke test**

Run: `bun run mma "hello"`
Expected: Connects to LLM (or fails with connection error if no server running) — at minimum doesn't crash with type errors

Run: `bun run mma --help`
Expected: Usage output unchanged

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/main.ts
git commit -m "feat: wire agent loop to CLI entry point"
```

---

### Task 7: Final verification

**Files:**
- No file changes

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: 184+ pass (4 new tests + 180 existing)

- [ ] **Step 3: Update AGENTS.md summary**

Mark Plan 09 as completed and add `core/agent.ts`, `core/bootstrap.ts` to the file tree.
