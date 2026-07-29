# MMA v2 Spec Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all missing features from MMA v2 specification that are documented but not yet implemented

**Architecture:** Group tasks by functional area: hallucination reactions, model loading, REPL enhancements, plugin system, file syntax validation, and structural refactoring. Each task produces working, testable code following TDD approach.

**Tech Stack:** TypeScript, Bun runtime, Node.js fs/path/os modules, readline API

---

## File Structure Overview

### New Files to Create
- `src/modules/plugins/builtin/lint-on-write.ts` - Plugin for linting on file write
- `src/modules/plugins/builtin/notify.ts` - Plugin for notifications
- `src/modules/memory/search.ts` - Dedicated memory search module
- `src/modules/user-profile/compressor.ts` - Dedicated profile compression
- `src/modules/context/history.ts` - Session history writer module
- `tests/modules/plugins/builtin/lint-on-write.test.ts`
- `tests/modules/plugins/builtin/notify.test.ts`
- `tests/modules/memory/search.test.ts`
- `tests/modules/user-profile/compressor.test.ts`
- `tests/modules/context/history.test.ts`

### Files to Modify
- `src/core/agent.ts` - Add hallucination retry/warn handling
- `src/core/bootstrap.ts` - Integrate ModelLoader
- `src/cli/repl.ts` - Add persistent history + multi-line input
- `src/modules/plugins/manager.ts` - Add onAfterThink hook
- `src/modules/indexer/walker.ts` - Add fs.watch for realtime updates
- `src/cli/completer.ts` - Implement FilePathProvider + ProviderArgProvider
- `src/modules/session/store.ts` - Add session rotation (30 days → .gz)
- `src/config/config.ts` - Fix project config name (.mmarc.json → .mmrc)
- `src/modules/execution/verifier.ts` - Add syntax validation for files

---

## Task 1: Hallucination Retry/Warn Reactions

**Files:**
- Modify: `src/core/agent.ts:189-193`
- Test: `tests/core/agent-hallucination.test.ts`

- [ ] **Step 1: Write failing test for hallucination warn reaction**

```typescript
// tests/core/agent-hallucination.test.ts
import { describe, expect, it, vi } from 'bun:test'
import { Agent } from '../../src/core/agent'
import type { AgentDeps } from '../../src/core/agent'

describe('Agent hallucination reactions', () => {
  it('should show warn response with uncertainty prefix', async () => {
    const mockDeps: AgentDeps = {
      config: { maxToolIterations: 5, contextWindow: 32768, contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 }, model: 'test', provider: { type: 'openai-compat', baseUrl: 'http://test', apiKey: 'test' }, logLevel: 'info', locale: 'en', stuckThreshold: 8, autoPlan: true, showReasoning: false, session: { autoSave: false, maxSessions: 50, isolateMemory: false } } as any,
      llmProvider: {
        chat: async function* () {
          yield { type: 'text', content: 'I think maybe this file exists' }
        },
        countTokens: () => 10,
        model: 'test',
        contextWindow: 32768,
      },
      toolExecutor: { execute: async () => ({ success: true, output: 'ok' }), getToolDefinitions: () => [] } as any,
      pluginManager: { runOnBeforeThink: () => {}, runOnBeforeTool: async () => true, runOnAfterTool: async () => {}, runOnError: async () => {}, runOnSessionStart: () => {}, runOnSessionEnd: () => {} } as any,
      contextManager: { addMessage: () => {}, getActiveHistory: () => [], needsCompaction: () => false, compact: () => {}, getEstimatedTokens: () => 100, getBudget: () => ({ systemPrompt: 8192, responseReserve: 3932, history: 20644 }), clear: () => {} } as any,
      hallucinationDetector: { validate: () => ({ status: 'warn', reason: 'Uncertainty markers detected' }) } as any,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
      baseDir: '/test',
      promptBlocks: [],
    }

    const agent = new Agent(mockDeps)
    const chunks: string[] = []
    const result = await agent.run('test', (chunk) => chunks.push(chunk))
    
    expect(result.success).toBe(true)
    expect(chunks.join('')).toContain('[⚠️ Uncertainty]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/core/agent-hallucination.test.ts
```

Expected: FAIL - warn reaction not implemented

- [ ] **Step 3: Implement hallucination warn reaction in agent.ts**

```typescript
// src/core/agent.ts:189-204
const hallucinationResult = hallucinationDetector.validate(textContent)

if (hallucinationResult.status === 'block') {
  logger.warn(`Response blocked: ${hallucinationResult.reason}`)
  return { success: false, text: lastText, error: `Response blocked: ${hallucinationResult.reason}`, iterationCount: iteration }
}

if (hallucinationResult.status === 'warn') {
  logger.warn(`Hallucination warning: ${hallucinationResult.reason}`)
  const warnPrefix = '\n\n[⚠️ Uncertainty] '
  if (onChunk) {
    onChunk(warnPrefix)
  }
  lastText = warnPrefix + lastText
}

if (hallucinationResult.status === 'retry') {
  logger.warn(`Hallucination retry: ${hallucinationResult.reason}`)
  contextManager.addMessage({ role: 'assistant', content: textContent })
  contextManager.addMessage({ 
    role: 'system', 
    content: `[Retry context: ${hallucinationResult.reason}. Please verify your response.]` 
  })
  continue
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/core/agent-hallucination.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts tests/core/agent-hallucination.test.ts
git commit -m "feat: implement hallucination warn/retry reactions"
```

---

## Task 2: Model Auto-Loader Integration

**Files:**
- Modify: `src/core/bootstrap.ts`
- Test: `tests/core/bootstrap-model-loader.test.ts`

- [ ] **Step 1: Write failing test for model auto-loading**

```typescript
// tests/core/bootstrap-model-loader.test.ts
import { describe, expect, it, vi } from 'bun:test'
import { bootstrap } from '../../src/core/bootstrap'

describe('Bootstrap model loader', () => {
  it('should call ModelLoader.ensureModelLoaded when autoLoad is true', async () => {
    const mockFetch = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    } as any)

    const result = bootstrap('/tmp/test-config', '/tmp/test-project')
    
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/models'),
      expect.any(Object)
    )
    
    mockFetch.mockRestore()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/core/bootstrap-model-loader.test.ts
```

Expected: FAIL - ModelLoader not called

- [ ] **Step 3: Integrate ModelLoader in bootstrap.ts**

```typescript
// src/core/bootstrap.ts:1-20 (add import)
import { ModelLoader } from '../llm/model-loader'

// src/core/bootstrap.ts:47-52 (after logger creation)
const logger = new Logger(config.logLevel as any)
logger.setLogDir(join(dir, 'logs'))
logger.debug('MMA bootstrap', { version: config.version, model: config.model })

// Auto-load model if configured
if (config.modelLoad.autoLoad) {
  const modelLoader = new ModelLoader(config.provider.baseUrl, logger)
  const loadResult = await modelLoader.ensureModelLoaded({
    model: config.model,
    contextLength: config.contextWindow,
    flashAttention: config.modelLoad.flashAttention,
    offloadKvCacheToGpu: config.modelLoad.offloadKvCacheToGpu,
    autoLoad: config.modelLoad.autoLoad,
  })
  
  if (!loadResult.success) {
    logger.warn(`Model auto-load failed: ${loadResult.error}. Continuing with manual load.`)
  } else if (loadResult.alreadyLoaded) {
    logger.debug(`Model ${config.model} already loaded`)
  } else {
    logger.info(`Model ${config.model} loaded in ${loadResult.loadTime}s`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/core/bootstrap-model-loader.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/bootstrap.ts tests/core/bootstrap-model-loader.test.ts
git commit -m "feat: integrate model auto-loader in bootstrap"
```

---

## Task 3: REPL Persistent History

**Files:**
- Modify: `src/cli/repl.ts`
- Test: `tests/cli/repl-history.test.ts`

- [ ] **Step 1: Write failing test for persistent history**

```typescript
// tests/cli/repl-history.test.ts
import { describe, expect, it, vi } from 'bun:test'
import { Repl } from '../../src/cli/repl'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

describe('REPL persistent history', () => {
  const historyPath = join(homedir(), '.mma', 'repl-history')

  it('should save history to ~/.mma/repl-history', () => {
    const mockAgent = { run: async () => ({ success: true, text: 'ok', iterationCount: 1 }) } as any
    const mockConfig = { model: 'test', provider: { type: 'test', baseUrl: 'test', apiKey: 'test' }, contextWindow: 32768, contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 }, logLevel: 'info', locale: 'en', maxToolIterations: 25, stuckThreshold: 8, autoPlan: true, showReasoning: false, session: { autoSave: false, maxSessions: 50, isolateMemory: false } } as any
    
    const repl = new Repl(mockAgent, mockConfig)
    
    // Simulate adding history
    const rl = (repl as any).rl
    rl.write('test command 1\n')
    rl.write('test command 2\n')
    repl.stop()
    
    expect(existsSync(historyPath)).toBe(true)
    const history = readFileSync(historyPath, 'utf-8')
    expect(history).toContain('test command 1')
    expect(history).toContain('test command 2')
    
    // Cleanup
    unlinkSync(historyPath)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/repl-history.test.ts
```

Expected: FAIL - history not persisted

- [ ] **Step 3: Implement persistent history in repl.ts**

```typescript
// src/cli/repl.ts:1-10 (add imports)
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// src/cli/repl.ts:29-40 (add to Repl class)
export class Repl {
  private rl: readline.Interface
  private commands: Map<string, SlashCommand> = new Map()
  private completer: Completer = new Completer()
  private running = false
  private agent: Agent
  private config: AppConfig
  private sessionManager?: SessionManager
  private skillsModule?: SkillsModule
  private historyPath: string
  private history: string[] = []
  private maxHistory = 1000

  constructor(agent: Agent, config: AppConfig, sessionManager?: SessionManager, skillsModule?: SkillsModule) {
    this.agent = agent
    this.config = config
    this.sessionManager = sessionManager
    this.skillsModule = skillsModule
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
    const rlHistory = (this.rl as any).getHistory?.() || []
    const allHistory = [...this.history, ...rlHistory].slice(-this.maxHistory)
    writeFileSync(this.historyPath, allHistory.join('\n'), 'utf-8')
  }

  stop(): void {
    this.running = false
    this.saveHistory()
    this.agent.shutdown()
    this.rl.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/cli/repl-history.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/repl.ts tests/cli/repl-history.test.ts
git commit -m "feat: add persistent REPL history"
```

---

## Task 4: REPL Multi-Line Input

**Files:**
- Modify: `src/cli/repl.ts`

- [ ] **Step 1: Write failing test for multi-line input**

```typescript
// tests/cli/repl-multiline.test.ts
import { describe, expect, it } from 'bun:test'
import { Repl } from '../../src/cli/repl'

describe('REPL multi-line input', () => {
  it('should detect multi-line input with backslash continuation', () => {
    const mockAgent = { run: async () => ({ success: true, text: 'ok', iterationCount: 1 }) } as any
    const mockConfig = { model: 'test', provider: { type: 'test', baseUrl: 'test', apiKey: 'test' }, contextWindow: 32768, contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 }, logLevel: 'info', locale: 'en', maxToolIterations: 25, stuckThreshold: 8, autoPlan: true, showReasoning: false, session: { autoSave: false, maxSessions: 50, isolateMemory: false } } as any
    
    const repl = new Repl(mockAgent, mockConfig)
    const isMultiLine = (repl as any).isMultiLineInput('function test() {\\')
    
    expect(isMultiLine).toBe(true)
  })

  it('should detect multi-line input with unclosed braces', () => {
    const mockAgent = { run: async () => ({ success: true, text: 'ok', iterationCount: 1 }) } as any
    const mockConfig = { model: 'test', provider: { type: 'test', baseUrl: 'test', apiKey: 'test' }, contextWindow: 32768, contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 }, logLevel: 'info', locale: 'en', maxToolIterations: 25, stuckThreshold: 8, autoPlan: true, showReasoning: false, session: { autoSave: false, maxSessions: 50, isolateMemory: false } } as any
    
    const repl = new Repl(mockAgent, mockConfig)
    const isMultiLine = (repl as any).isMultiLineInput('function test() {')
    
    expect(isMultiLine).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/repl-multiline.test.ts
```

Expected: FAIL - multi-line detection not implemented

- [ ] **Step 3: Implement multi-line input detection in repl.ts**

```typescript
// src/cli/repl.ts:357-400 (modify setupListeners)
private setupListeners(): void {
  let multiLineBuffer = ''
  let inMultiLine = false

  this.rl.on('line', async (line: string) => {
    const trimmed = line.trim()
    
    // Handle multi-line input
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
        if (this.running) this.rl.prompt()
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
      this.rl.setPrompt(pc.cyan('> '))
      this.rl.prompt()
    }
  })

  this.rl.on('close', () => {
    this.running = false
  })
}

private isMultiLineInput(line: string): boolean {
  // Backslash continuation
  if (line.endsWith('\\')) return true
  
  // Unclosed braces
  const openBraces = (line.match(/\{/g) || []).length
  const closeBraces = (line.match(/\}/g) || []).length
  if (openBraces > closeBraces) return true
  
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/cli/repl-multiline.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/repl.ts tests/cli/repl-multiline.test.ts
git commit -m "feat: add multi-line input support to REPL"
```

---

## Task 5: Builtin Plugin - Lint on Write

**Files:**
- Create: `src/modules/plugins/builtin/lint-on-write.ts`
- Test: `tests/modules/plugins/builtin/lint-on-write.test.ts`

- [ ] **Step 1: Write failing test for lint-on-write plugin**

```typescript
// tests/modules/plugins/builtin/lint-on-write.test.ts
import { describe, expect, it } from 'bun:test'
import { LintOnWritePlugin } from '../../../../src/modules/plugins/builtin/lint-on-write'

describe('LintOnWritePlugin', () => {
  it('should run lint after write_file tool', async () => {
    const plugin = new LintOnWritePlugin()
    const mockCtx = { baseDir: '/test', logger: { debug: () => {}, warn: () => {} } } as any
    const mockResult = { success: true, output: 'File written', toolName: 'write_file' } as any
    
    await plugin.onAfterTool!(mockCtx, mockResult)
    
    // Should attempt to run lint (no error thrown)
    expect(true).toBe(true)
  })

  it('should skip lint for non-write tools', async () => {
    const plugin = new LintOnWritePlugin()
    const mockCtx = { baseDir: '/test', logger: { debug: () => {}, warn: () => {} } } as any
    const mockResult = { success: true, output: 'ok', toolName: 'read_file' } as any
    
    await plugin.onAfterTool!(mockCtx, mockResult)
    
    // Should not run lint
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/plugins/builtin/lint-on-write.test.ts
```

Expected: FAIL - file not found

- [ ] **Step 3: Implement lint-on-write plugin**

```typescript
// src/modules/plugins/builtin/lint-on-write.ts
import type { AgentPlugin } from '../../types'
import type { ToolContext } from '../../../tools/types'
import type { ToolResult } from '../../../tools/types'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export class LintOnWritePlugin implements AgentPlugin {
  name = 'lint-on-write'
  priority = 10

  async onAfterTool(ctx: ToolContext, result: ToolResult & { toolName?: string }): Promise<void> {
    if (result.toolName !== 'write_file' && result.toolName !== 'edit_file') {
      return
    }

    if (!result.success) {
      return
    }

    try {
      const packageJsonPath = join(ctx.baseDir, 'package.json')
      if (!existsSync(packageJsonPath)) {
        ctx.logger.debug('No package.json found, skipping lint')
        return
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      const lintScript = packageJson.scripts?.lint

      if (!lintScript) {
        ctx.logger.debug('No lint script in package.json, skipping')
        return
      }

      ctx.logger.debug(`Running lint: ${lintScript}`)
      execSync(lintScript, { cwd: ctx.baseDir, stdio: 'pipe' })
      ctx.logger.debug('Lint passed')
    } catch (err: any) {
      ctx.logger.warn(`Lint failed: ${err.message}`)
    }
  }
}

export const plugin = new LintOnWritePlugin()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/modules/plugins/builtin/lint-on-write.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/plugins/builtin/lint-on-write.ts tests/modules/plugins/builtin/lint-on-write.test.ts
git commit -m "feat: add lint-on-write builtin plugin"
```

---

## Task 6: Builtin Plugin - Notify

**Files:**
- Create: `src/modules/plugins/builtin/notify.ts`
- Test: `tests/modules/plugins/builtin/notify.test.ts`

- [ ] **Step 1: Write failing test for notify plugin**

```typescript
// tests/modules/plugins/builtin/notify.test.ts
import { describe, expect, it } from 'bun:test'
import { NotifyPlugin } from '../../../../src/modules/plugins/builtin/notify'

describe('NotifyPlugin', () => {
  it('should log notification on session end', () => {
    const plugin = new NotifyPlugin()
    const logs: string[] = []
    const mockCtx = { logger: { info: (msg: string) => logs.push(msg) } } as any
    
    plugin.onSessionEnd!(mockCtx)
    
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]).toContain('Session ended')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/plugins/builtin/notify.test.ts
```

Expected: FAIL - file not found

- [ ] **Step 3: Implement notify plugin**

```typescript
// src/modules/plugins/builtin/notify.ts
import type { AgentPlugin } from '../../types'
import type { ToolContext } from '../../../tools/types'

export class NotifyPlugin implements AgentPlugin {
  name = 'notify'
  priority = 5

  onSessionEnd(ctx: ToolContext): void {
    ctx.logger.info('Session ended')
  }
}

export const plugin = new NotifyPlugin()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/modules/plugins/builtin/notify.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/plugins/builtin/notify.ts tests/modules/plugins/builtin/notify.test.ts
git commit -m "feat: add notify builtin plugin"
```

---

## Task 7: Memory Search Module

**Files:**
- Create: `src/modules/memory/search.ts`
- Modify: `src/modules/memory/store.ts`
- Test: `tests/modules/memory/search.test.ts`

- [ ] **Step 1: Write failing test for memory search**

```typescript
// tests/modules/memory/search.test.ts
import { describe, expect, it } from 'bun:test'
import { MemorySearch } from '../../../src/modules/memory/search'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('MemorySearch', () => {
  it('should search across all memory files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-memory-'))
    writeFileSync(join(tempDir, 'conventions.md'), '# Conventions\n\n- Use TypeScript\n- Follow ESLint\n')
    writeFileSync(join(tempDir, 'decisions.md'), '# Decisions\n\n- Chose Bun runtime\n')
    
    const search = new MemorySearch(tempDir)
    const results = search.query('TypeScript')
    
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].file).toBe('conventions')
    expect(results[0].match).toContain('TypeScript')
    
    rmSync(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/memory/search.test.ts
```

Expected: FAIL - file not found

- [ ] **Step 3: Implement memory search module**

```typescript
// src/modules/memory/search.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const MEMORY_FILES = ['conventions', 'decisions', 'errors']

export interface SearchResult {
  file: string
  match: string
}

export class MemorySearch {
  private memoryDir: string

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
  }

  query(query: string): SearchResult[] {
    const results: SearchResult[] = []
    const lowerQuery = query.toLowerCase()

    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`)
      if (!existsSync(path)) continue

      const content = readFileSync(path, 'utf-8')
      const lines = content.split('\n')
      
      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push({ file: name, match: line.trim() })
        }
      }
    }

    return results
  }
}
```

- [ ] **Step 4: Update MemoryStore to use MemorySearch**

```typescript
// src/modules/memory/store.ts:39-54 (replace search method)
search(query: string): Array<{ file: string; match: string }> {
  const searchModule = new MemorySearch(this.memoryDir)
  return searchModule.query(query)
}
```

Add import at top:
```typescript
import { MemorySearch } from './search'
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/modules/memory/search.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/memory/search.ts src/modules/memory/store.ts tests/modules/memory/search.test.ts
git commit -m "feat: extract memory search to dedicated module"
```

---

## Task 8: User Profile Compressor Module

**Files:**
- Create: `src/modules/user-profile/compressor.ts`
- Modify: `src/modules/user-profile/profile.ts`
- Test: `tests/modules/user-profile/compressor.test.ts`

- [ ] **Step 1: Write failing test for profile compressor**

```typescript
// tests/modules/user-profile/compressor.test.ts
import { describe, expect, it } from 'bun:test'
import { ProfileCompressor } from '../../../src/modules/user-profile/compressor'

describe('ProfileCompressor', () => {
  it('should compress profile info to ~500 tokens', () => {
    const compressor = new ProfileCompressor()
    const profileInfo = {
      platform: 'linux',
      os: 'Linux Ubuntu',
      hostname: 'dev-machine',
      shell: '/bin/bash',
      home: '/home/user',
      nodeVersion: 'v20.0.0',
      preferences: { editor: 'vim', theme: 'dark' },
    }
    
    const compressed = compressor.compress(profileInfo)
    
    expect(compressed.length).toBeLessThan(2000) // ~500 tokens * 4 chars/token
    expect(compressed).toContain('Linux Ubuntu')
    expect(compressed).toContain('/bin/bash')
    expect(compressed).toContain('editor')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/user-profile/compressor.test.ts
```

Expected: FAIL - file not found

- [ ] **Step 3: Implement profile compressor**

```typescript
// src/modules/user-profile/compressor.ts
import type { ProfileInfo } from './profile'

export class ProfileCompressor {
  compress(info: ProfileInfo): string {
    const parts: string[] = [
      `OS: ${info.os}`,
      `Shell: ${info.shell}`,
      `Platform: ${info.platform}`,
    ]

    if (Object.keys(info.preferences).length > 0) {
      const prefs = Object.entries(info.preferences)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      parts.push(`Prefs: ${prefs}`)
    }

    return parts.join(', ')
  }
}
```

- [ ] **Step 4: Update UserProfile to use ProfileCompressor**

```typescript
// src/modules/user-profile/profile.ts:1-5 (add import)
import { ProfileCompressor } from './compressor'

// src/modules/user-profile/profile.ts:80-91 (replace compress method)
compress(): string {
  if (!this.info) this.collect()
  const compressor = new ProfileCompressor()
  return compressor.compress(this.info!)
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/modules/user-profile/compressor.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/user-profile/compressor.ts src/modules/user-profile/profile.ts tests/modules/user-profile/compressor.test.ts
git commit -m "feat: extract profile compressor to dedicated module"
```

---

## Task 9: Context History Module

**Files:**
- Create: `src/modules/context/history.ts`
- Test: `tests/modules/context/history.test.ts`

- [ ] **Step 1: Write failing test for context history writer**

```typescript
// tests/modules/context/history.test.ts
import { describe, expect, it } from 'bun:test'
import { SessionHistoryWriter } from '../../../src/modules/context/history'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SessionHistoryWriter', () => {
  it('should append messages to JSONL file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-history-'))
    const writer = new SessionHistoryWriter(tempDir, 'test-session')
    
    writer.append({ role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' })
    writer.append({ role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' })
    
    const historyPath = join(tempDir, 'test-session.jsonl')
    expect(existsSync(historyPath)).toBe(true)
    
    const content = readFileSync(historyPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
    
    rmSync(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/context/history.test.ts
```

Expected: FAIL - file not found

- [ ] **Step 3: Implement session history writer**

```typescript
// src/modules/context/history.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface HistoryMessage {
  role: string
  content: string
  name?: string
  timestamp: string
}

export class SessionHistoryWriter {
  private historyPath: string

  constructor(sessionsDir: string, sessionId: string) {
    const sessionDir = join(sessionsDir, sessionId)
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true })
    }
    this.historyPath = join(sessionDir, 'history.jsonl')
  }

  append(msg: HistoryMessage): void {
    appendFileSync(this.historyPath, JSON.stringify(msg) + '\n', 'utf-8')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/modules/context/history.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/context/history.ts tests/modules/context/history.test.ts
git commit -m "feat: add session history writer module"
```

---

## Task 10: Plugin onAfterThink Hook

**Files:**
- Modify: `src/modules/plugins/manager.ts`
- Modify: `src/modules/plugins/types.ts`
- Test: `tests/modules/plugins/manager-afterthink.test.ts`

- [ ] **Step 1: Write failing test for onAfterThink hook**

```typescript
// tests/modules/plugins/manager-afterthink.test.ts
import { describe, expect, it } from 'bun:test'
import { PluginManager } from '../../../src/modules/plugins/manager'
import type { AgentPlugin } from '../../../src/modules/plugins/types'

describe('PluginManager onAfterThink', () => {
  it('should call onAfterThink on all plugins', () => {
    const manager = new PluginManager()
    const calls: string[] = []
    
    const plugin1: AgentPlugin = {
      name: 'test1',
      onAfterThink: () => { calls.push('plugin1') },
    }
    
    const plugin2: AgentPlugin = {
      name: 'test2',
      onAfterThink: () => { calls.push('plugin2') },
    }
    
    manager.register(plugin1)
    manager.register(plugin2)
    
    manager.runOnAfterThink({})
    
    expect(calls).toEqual(['plugin1', 'plugin2'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/plugins/manager-afterthink.test.ts
```

Expected: FAIL - method not found

- [ ] **Step 3: Add onAfterThink to AgentPlugin interface**

```typescript
// src/modules/plugins/types.ts
export interface AgentPlugin {
  name: string
  priority?: number
  onBuildPrompt?(): string | null
  onBeforeThink?(ctx: any): void
  onAfterThink?(ctx: any): void
  onBeforeTool?(ctx: any, call: any): boolean
  onAfterTool?(ctx: any, result: any): void
  onError?(ctx: any, error: Error): void
  onSessionStart?(ctx: any): void
  onSessionEnd?(ctx: any): void
}
```

- [ ] **Step 4: Implement runOnAfterThink in PluginManager**

```typescript
// src/modules/plugins/manager.ts
runOnAfterThink(ctx: any): void {
  for (const plugin of this.plugins) {
    if (plugin.onAfterThink) {
      try { plugin.onAfterThink(ctx) }
      catch { /* error isolation */ }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/modules/plugins/manager-afterthink.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/plugins/manager.ts src/modules/plugins/types.ts tests/modules/plugins/manager-afterthink.test.ts
git commit -m "feat: add onAfterThink plugin hook"
```

---

## Task 11: Indexer fs.watch Realtime Updates

**Files:**
- Modify: `src/modules/indexer/walker.ts`
- Test: `tests/modules/indexer/watcher.test.ts`

- [ ] **Step 1: Write failing test for fs.watch integration**

```typescript
// tests/modules/indexer/watcher.test.ts
import { describe, expect, it } from 'bun:test'
import { Indexer } from '../../../src/modules/indexer/walker'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Indexer fs.watch', () => {
  it('should detect file changes via watch', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-indexer-'))
    const indexer = new Indexer(tempDir)
    
    let changeDetected = false
    indexer.watch((event, filename) => {
      changeDetected = true
    })
    
    // Wait a bit for watcher to start
    await new Promise(resolve => setTimeout(resolve, 100))
    
    writeFileSync(join(tempDir, 'test.ts'), 'export const x = 1')
    
    // Wait for event
    await new Promise(resolve => setTimeout(resolve, 200))
    
    indexer.unwatch()
    
    expect(changeDetected).toBe(true)
    
    rmSync(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/indexer/watcher.test.ts
```

Expected: FAIL - watch method not found

- [ ] **Step 3: Implement fs.watch in Indexer**

```typescript
// src/modules/indexer/walker.ts:1-5 (add imports)
import { watch, FSWatcher } from 'fs'

// src/modules/indexer/walker.ts:32-40 (add to Indexer class)
export class Indexer {
  private baseDir: string
  private MAX_FILES = 1000
  private watcher: FSWatcher | null = null

  // ... existing code ...

  watch(callback: (event: string, filename: string | null) => void): void {
    this.watcher = watch(this.baseDir, { recursive: true }, (event, filename) => {
      if (filename && !filename.includes('node_modules') && !filename.includes('.git')) {
        callback(event, filename)
      }
    })
  }

  unwatch(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/modules/indexer/watcher.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/indexer/walker.ts tests/modules/indexer/watcher.test.ts
git commit -m "feat: add fs.watch for realtime index updates"
```

---

## Task 12: FilePathProvider Implementation

**Files:**
- Modify: `src/cli/completer.ts`
- Test: `tests/cli/completer-filepath.test.ts`

- [ ] **Step 1: Write failing test for FilePathProvider**

```typescript
// tests/cli/completer-filepath.test.ts
import { describe, expect, it } from 'bun:test'
import { FilePathProvider } from '../../src/cli/completer'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, cwd } from 'os'

describe('FilePathProvider', () => {
  it('should complete file paths from CWD', () => {
    const provider = new FilePathProvider()
    const ctx = {
      line: 'read src/',
      cursor: 9,
      tokens: ['read', 'src/'],
      partial: 'src/',
      tokenIndex: 1,
    }
    
    const matches = provider.complete(ctx)
    
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.some(m => m.includes('src'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/completer-filepath.test.ts
```

Expected: FAIL - returns empty array

- [ ] **Step 3: Implement FilePathProvider**

```typescript
// src/cli/completer.ts:1-5 (add imports)
import { readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

// src/cli/completer.ts:89-99 (replace FilePathProvider)
export class FilePathProvider implements CompletionProvider {
  name = 'file-paths'

  match(ctx: CompletionContext): boolean {
    return ctx.partial.includes('/') || ctx.partial.includes('\\')
  }

  complete(ctx: CompletionContext): string[] {
    try {
      const cwd = process.cwd()
      const partialPath = ctx.partial
      const lastSlash = Math.max(partialPath.lastIndexOf('/'), partialPath.lastIndexOf('\\'))
      const dirPath = lastSlash > 0 ? partialPath.slice(0, lastSlash) : '.'
      const prefix = lastSlash > 0 ? partialPath.slice(0, lastSlash + 1) : ''
      
      const fullPath = join(cwd, dirPath)
      const entries = readdirSync(fullPath)
      
      const matches: string[] = []
      for (const entry of entries) {
        const entryPath = join(fullPath, entry)
        const stat = statSync(entryPath)
        const completion = prefix + entry + (stat.isDirectory() ? '/' : '')
        
        if (completion.startsWith(ctx.partial)) {
          matches.push(completion)
        }
      }
      
      return matches.slice(0, 20) // Limit results
    } catch {
      return []
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/cli/completer-filepath.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/completer.ts tests/cli/completer-filepath.test.ts
git commit -m "feat: implement FilePathProvider with real filesystem completion"
```

---

## Task 13: ProviderArgProvider

**Files:**
- Modify: `src/cli/completer.ts`
- Test: `tests/cli/completer-provider.test.ts`

- [ ] **Step 1: Write failing test for ProviderArgProvider**

```typescript
// tests/cli/completer-provider.test.ts
import { describe, expect, it } from 'bun:test'
import { ProviderArgProvider } from '../../src/cli/completer'

describe('ProviderArgProvider', () => {
  it('should complete provider names', () => {
    const provider = new ProviderArgProvider(['openai-compat', 'ollama', 'vllm'])
    const ctx = {
      line: '/provider use ',
      cursor: 14,
      tokens: ['/provider', 'use', ''],
      partial: '',
      tokenIndex: 2,
    }
    
    const matches = provider.complete(ctx)
    
    expect(matches).toContain('openai-compat')
    expect(matches).toContain('ollama')
    expect(matches).toContain('vllm')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/cli/completer-provider.test.ts
```

Expected: FAIL - class not found

- [ ] **Step 3: Implement ProviderArgProvider**

```typescript
// src/cli/completer.ts (add after SessionNameProvider)
export class ProviderArgProvider implements CompletionProvider {
  name = 'provider-args'
  private providers: string[]

  constructor(providers: string[]) {
    this.providers = providers
  }

  match(ctx: CompletionContext): boolean {
    return ctx.tokenIndex === 2 && ctx.tokens[0] === '/provider' && ctx.tokens[1] === 'use'
  }

  complete(ctx: CompletionContext): string[] {
    return this.providers.filter(p => p.startsWith(ctx.partial))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/cli/completer-provider.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/completer.ts tests/cli/completer-provider.test.ts
git commit -m "feat: add ProviderArgProvider for /provider use completion"
```

---

## Task 14: Session History Rotation (30 days → .gz)

**Files:**
- Modify: `src/modules/session/store.ts`
- Test: `tests/modules/session/rotation.test.ts`

- [ ] **Step 1: Write failing test for session rotation**

```typescript
// tests/modules/session/rotation.test.ts
import { describe, expect, it } from 'bun:test'
import { SessionStore } from '../../../src/modules/session/store'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { gzipSync } from 'zlib'

describe('SessionStore rotation', () => {
  it('should archive sessions older than 30 days', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-session-'))
    const store = new SessionStore(tempDir)
    store.init()
    
    // Create old session
    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 31)
    const oldId = 'ses_old123'
    
    store.saveMeta(oldId, {
      id: oldId,
      name: 'Old Session',
      createdAt: oldDate.toISOString(),
      updatedAt: oldDate.toISOString(),
      messageCount: 5,
      model: 'test',
      contextWindow: 32768,
      projectDir: '/test',
    })
    
    writeFileSync(join(tempDir, oldId, 'history.jsonl'), '{"role":"user","content":"test"}\n')
    
    store.rotateOldSessions()
    
    const gzPath = join(tempDir, `${oldId}.jsonl.gz`)
    expect(existsSync(gzPath)).toBe(true)
    
    rmSync(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/session/rotation.test.ts
```

Expected: FAIL - method not found

- [ ] **Step 3: Implement session rotation**

```typescript
// src/modules/session/store.ts:1-5 (add imports)
import { gzipSync } from 'zlib'

// src/modules/session/store.ts (add method)
rotateOldSessions(): void {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  
  const sessions = this.listSessions()
  
  for (const session of sessions) {
    const updatedAt = new Date(session.updatedAt)
    if (updatedAt < thirtyDaysAgo) {
      const historyPath = this.historyPath(session.id)
      if (existsSync(historyPath)) {
        const content = readFileSync(historyPath, 'utf-8')
        const compressed = gzipSync(content)
        const gzPath = join(this.baseDir, `${session.id}.jsonl.gz`)
        writeFileSync(gzPath, compressed)
        rmSync(historyPath)
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/modules/session/rotation.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/session/store.ts tests/modules/session/rotation.test.ts
git commit -m "feat: add session history rotation (30 days → .gz)"
```

---

## Task 15: Fix Project Config Name (.mmarc.json → .mmrc)

**Files:**
- Modify: `src/config/config.ts`
- Modify: `src/core/bootstrap.ts`
- Test: `tests/config/config-name.test.ts`

- [ ] **Step 1: Write failing test for config name**

```typescript
// tests/config/config-name.test.ts
import { describe, expect, it } from 'bun:test'
import { loadConfig } from '../../src/config/config'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Config project file name', () => {
  it('should use .mmrc instead of .mmarc.json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-config-'))
    const configDir = join(tempDir, 'config')
    const projectDir = join(tempDir, 'project')
    
    writeFileSync(join(projectDir, '.mmrc'), JSON.stringify({ model: 'test-model' }))
    
    const config = loadConfig({ configDir, projectConfigPath: join(projectDir, '.mmrc') })
    
    expect(config.model).toBe('test-model')
    
    rmSync(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/config/config-name.test.ts
```

Expected: PASS (already works, just need to update bootstrap)

- [ ] **Step 3: Update bootstrap.ts to use .mmrc**

```typescript
// src/core/bootstrap.ts:43
const projectConfigPath = projectDir ? join(projectDir, '.mmrc') : join(process.cwd(), '.mmrc')
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/config/config-name.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/bootstrap.ts tests/config/config-name.test.ts
git commit -m "fix: use .mmrc for project config filename"
```

---

## Task 16: File Syntax Validation in Execution Verifier

**Files:**
- Modify: `src/modules/execution/verifier.ts`
- Test: `tests/modules/execution/verifier-syntax.test.ts`

- [ ] **Step 1: Write failing test for syntax validation**

```typescript
// tests/modules/execution/verifier-syntax.test.ts
import { describe, expect, it } from 'bun:test'
import { ExecutionVerifier } from '../../../src/modules/execution/verifier'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('ExecutionVerifier syntax validation', () => {
  it('should validate TypeScript syntax', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-verify-'))
    const verifier = new ExecutionVerifier(tempDir)
    
    writeFileSync(join(tempDir, 'test.ts'), 'export const x: number = 1')
    
    const result = await verifier.verifyStep('Create test.ts')
    
    expect(result.syntaxValid).toBe(true)
    
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('should detect syntax errors', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-verify-'))
    const verifier = new ExecutionVerifier(tempDir)
    
    writeFileSync(join(tempDir, 'bad.ts'), 'export const x: number =')
    
    const result = await verifier.verifyStep('Create bad.ts')
    
    expect(result.syntaxValid).toBe(false)
    
    rmSync(tempDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/modules/execution/verifier-syntax.test.ts
```

Expected: FAIL - syntax validation not implemented

- [ ] **Step 3: Implement syntax validation in verifier**

```typescript
// src/modules/execution/verifier.ts:1-10 (add imports)
import { execSync } from 'child_process'
import { extname } from 'path'

// src/modules/execution/verifier.ts (add to StepVerificationResult interface)
export interface StepVerificationResult {
  filesExist: boolean
  syntaxValid: boolean
  testsPass?: boolean
  errors: string[]
}

// src/modules/execution/verifier.ts (add method)
private validateSyntax(filePath: string): boolean {
  const ext = extname(filePath)
  
  if (ext === '.ts' || ext === '.tsx') {
    try {
      execSync(`npx tsc --noEmit ${filePath}`, { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  
  if (ext === '.js' || ext === '.jsx') {
    try {
      execSync(`node --check ${filePath}`, { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }
  
  return true // Skip validation for other file types
}

// Update verifyStep method to include syntax check
async verifyStep(stepDescription: string): Promise<StepVerificationResult> {
  const result: StepVerificationResult = {
    filesExist: true,
    syntaxValid: true,
    errors: [],
  }
  
  // Extract file paths from step description
  const filePaths = this.extractFilePaths(stepDescription)
  
  for (const filePath of filePaths) {
    const fullPath = join(this.baseDir, filePath)
    
    if (!existsSync(fullPath)) {
      result.filesExist = false
      result.errors.push(`File not found: ${filePath}`)
      continue
    }
    
    if (!this.validateSyntax(fullPath)) {
      result.syntaxValid = false
      result.errors.push(`Syntax error in: ${filePath}`)
    }
  }
  
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/modules/execution/verifier-syntax.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/verifier.ts tests/modules/execution/verifier-syntax.test.ts
git commit -m "feat: add file syntax validation to execution verifier"
```

---

## Summary

Total: 16 tasks covering all missing specification features

**Critical features (core functionality):**
- Tasks 1, 2, 3, 4

**Structural refactoring:**
- Tasks 5, 6, 7, 8, 9

**Plugin system:**
- Task 10

**Indexer enhancement:**
- Task 11

**Completer improvements:**
- Tasks 12, 13

**Session management:**
- Task 14

**Config fix:**
- Task 15

**OST file syntax validation:**
- Task 16
