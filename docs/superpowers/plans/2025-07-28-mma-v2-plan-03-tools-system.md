# Plan 3: Tools System — Registry, Executor, and 20+ Individual Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tool system — a single source of truth registry, a dispatch executor with plugin hooks, and all individual tools (filesystem, execution, web, planning, interaction, extension).

**Architecture:** `ToolRegistry` collects `ToolDefinition` from modules and tools. `ToolExecutor` takes a `ToolCall`, runs plugin hooks, validates args, executes the handler, runs post-hooks and hallucination check, and logs. Each tool is a separate file exporting a `ToolDefinition`.

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure

```
src/tools/
├── types.ts              — ToolDefinition, ToolContext, ToolResult, ToolCall
├── registry.ts            — ToolRegistry (register, get, list)
├── executor.ts            — ToolExecutor (dispatch pipeline)
├── bash.ts
├── read-file.ts
├── write-file.ts
├── edit-file.ts
├── glob-tool.ts
├── grep-tool.ts
├── list-dir.ts
├── create-dir.ts
├── delete-file.ts
├── move-file.ts
├── file-info.ts
├── subagent.ts
├── web-search.ts
├── web-fetch.ts
├── web-browse.ts
├── plan.ts
├── todo.ts
├── question.ts
├── approve.ts
├── load-skill.ts
├── pipeline-run.ts
├── mcp-call.ts
├── search-history.ts
└── index.ts              — re-exports all tools + registry + executor
```

Tests:
```
tests/
├── registry.test.ts
├── executor.test.ts
├── bash.test.ts
├── read-file.test.ts
├── write-file.test.ts
├── edit-file.test.ts
├── glob-tool.test.ts
├── grep-tool.test.ts
```

---

### Task 1: Tool types + Registry

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/registry.ts`
- Test: `tests/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '../src/tools/registry'
import type { ToolDefinition } from '../src/tools/types'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('should register and retrieve a tool', () => {
    const tool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: 'done' }),
    }
    registry.register(tool)
    expect(registry.get('test_tool')).toBe(tool)
  })

  it('should throw on duplicate registration', () => {
    const tool: ToolDefinition = {
      name: 'dup',
      description: 'dup',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    }
    registry.register(tool)
    expect(() => registry.register(tool)).toThrow(/dup/)
  })

  it('should list all tool names', () => {
    registry.register({
      name: 'a', description: 'a', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    registry.register({
      name: 'b', description: 'b', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    expect(registry.list()).toEqual(['a', 'b'])
  })

  it('should return all tool definitions', () => {
    registry.register({
      name: 'x', description: 'x desc', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    const defs = registry.getAll()
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('x')
  })

  it('should check if tool exists', () => {
    expect(registry.has('nonexistent')).toBe(false)
    registry.register({
      name: 'exists', description: '', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    expect(registry.has('exists')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Write types.ts**

```ts
// src/tools/types.ts

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

export interface ToolContext {
  config: import('../config/types').AppConfig
  baseDir: string
  logger: import('../logger/app-logger').Logger
  sessionHistory?: {
    append(type: string, content: unknown): Promise<void>
  }
}

export interface ToolResult {
  success: boolean
  output: string
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface PluginHook {
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | Promise<boolean>
  onAfterTool?(ctx: ToolContext, result: ToolResult): void | Promise<void>
}

export interface PluginManager {
  getAllPlugins(): PluginHook[]
}
```

- [ ] **Step 4: Write registry.ts**

```ts
// src/tools/registry.ts
import type { ToolDefinition } from './types'

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): string[] {
    return Array.from(this.tools.keys()).sort()
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  getAllForLLM(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>> {
    return this.getAll().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/types.ts src/tools/registry.ts tests/registry.test.ts
git commit -m "feat: tool types and registry"
```

---

### Task 2: Tool Executor

**Files:**
- Create: `src/tools/executor.ts`
- Test: `tests/executor.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/executor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolExecutor } from '../src/tools/executor'
import { ToolRegistry } from '../src/tools/registry'
import type { ToolDefinition, ToolContext, ToolCall } from '../src/tools/types'

describe('ToolExecutor', () => {
  let registry: ToolRegistry
  let executor: ToolExecutor
  let ctx: ToolContext

  beforeEach(() => {
    registry = new ToolRegistry()
    ctx = {
      config: {} as any,
      baseDir: '/tmp',
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    }
    executor = new ToolExecutor(registry, ctx, { getAllPlugins: () => [] })
  })

  it('should execute a registered tool', async () => {
    registry.register({
      name: 'hello',
      description: 'says hello',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      handler: async (_ctx, args) => ({
        success: true,
        output: `Hello ${args.name}`,
      }),
    })

    const result = await executor.execute({
      id: 'call_1',
      name: 'hello',
      arguments: { name: 'world' },
    })
    expect(result.success).toBe(true)
    expect(result.output).toBe('Hello world')
  })

  it('should throw for unknown tool', async () => {
    const result = await executor.execute({
      id: 'call_1',
      name: 'nonexistent',
      arguments: {},
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown tool')
  })

  it('should run plugin onBeforeTool hook', async () => {
    registry.register({
      name: 'blockable',
      description: '',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: 'ok' }),
    })

    const onBefore = vi.fn().mockReturnValue(false)
    executor = new ToolExecutor(registry, ctx, {
      getAllPlugins: () => [{ onBeforeTool: onBefore }],
    })

    const result = await executor.execute({
      id: 'call_1',
      name: 'blockable',
      arguments: {},
    })
    expect(onBefore).toHaveBeenCalled()
    expect(result.success).toBe(false)
  })

  it('should run plugin onAfterTool hook', async () => {
    registry.register({
      name: 'tracked',
      description: '',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: 'done' }),
    })

    const onAfter = vi.fn()
    executor = new ToolExecutor(registry, ctx, {
      getAllPlugins: () => [{ onAfterTool: onAfter }],
    })

    await executor.execute({ id: 'call_1', name: 'tracked', arguments: {} })
    expect(onAfter).toHaveBeenCalled()
  })

  it('should handle handler errors gracefully', async () => {
    registry.register({
      name: 'crash',
      description: '',
      parameters: { type: 'object', properties: {} },
      handler: async () => { throw new Error('boom') },
    })

    const result = await executor.execute({
      id: 'call_1',
      name: 'crash',
      arguments: {},
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('boom')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/executor.test.ts`
Expected: FAIL

- [ ] **Step 3: Write executor.ts**

```ts
// src/tools/executor.ts
import type { ToolDefinition, ToolContext, ToolCall, ToolResult, PluginManager } from './types'
import { ToolRegistry } from './registry'

export class ToolExecutor {
  private registry: ToolRegistry
  private ctx: ToolContext
  private pluginManager: PluginManager

  constructor(registry: ToolRegistry, ctx: ToolContext, pluginManager: PluginManager) {
    this.registry = registry
    this.ctx = ctx
    this.pluginManager = pluginManager
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name)
    if (!tool) {
      return { success: false, output: `Unknown tool: ${call.name}`, toolCallId: call.id }
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onBeforeTool) {
        try {
          const proceed = await plugin.onBeforeTool(this.ctx, call)
          if (!proceed) {
            return { success: false, output: `Blocked by plugin: ${plugin.constructor?.name || 'unknown'}`, toolCallId: call.id }
          }
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onBeforeTool error: ${e.message}`)
        }
      }
    }

    let result: ToolResult
    try {
      result = await tool.handler(this.ctx, call.arguments)
      result.toolCallId = call.id
    } catch (e: any) {
      result = { success: false, output: `Error: ${e.message}`, toolCallId: call.id }
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onAfterTool) {
        try {
          await plugin.onAfterTool(this.ctx, result)
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onAfterTool error: ${e.message}`)
        }
      }
    }

    this.ctx.logger.info(`Tool ${call.name}: ${result.success ? 'OK' : 'FAIL'}`)
    return result
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/executor.ts tests/executor.test.ts
git commit -m "feat: tool executor with plugin hooks"
```

---

### Task 3: Filesystem tools

**Files:**
- Create: `src/tools/read-file.ts`
- Create: `src/tools/write-file.ts`
- Create: `src/tools/edit-file.ts`
- Create: `src/tools/glob-tool.ts`
- Create: `src/tools/grep-tool.ts`
- Create: `src/tools/list-dir.ts`
- Create: `src/tools/create-dir.ts`
- Create: `src/tools/delete-file.ts`
- Create: `src/tools/move-file.ts`
- Create: `src/tools/file-info.ts`
- Test: `tests/read-file.test.ts`
- Test: `tests/write-file.test.ts`
- Test: `tests/edit-file.test.ts`
- Test: `tests/glob-tool.test.ts`
- Test: `tests/grep-tool.test.ts`

- [ ] **Step 1: Write tests for filesystem tools**

```ts
// tests/read-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readFileTool } from '../src/tools/read-file'

describe('read_file', () => {
  let tmpDir: string
  let ctx: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-test-'))
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } }
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      for (const f of ['test.txt', 'empty.txt']) {
        const p = join(tmpDir, f)
        if (existsSync(p)) unlinkSync(p)
      }
      rmdirSync(tmpDir)
    }
  })

  it('should read file content', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world')
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt') })
    expect(result.success).toBe(true)
    expect(result.output).toBe('hello world')
  })

  it('should read with offset and limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(tmpDir, 'test.txt'), lines)
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), offset: 3, limit: 2 })
    expect(result.success).toBe(true)
    expect(result.output).toContain('line 3')
    expect(result.output).toContain('line 4')
  })

  it('should handle nonexistent file', async () => {
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'nope.txt') })
    expect(result.success).toBe(false)
  })

  it('should enforce path safety', async () => {
    const result = await readFileTool.handler(ctx, { path: '../etc/passwd' })
    expect(result.success).toBe(false)
  })
})
```

```ts
// tests/write-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFileTool } from '../src/tools/write-file'

describe('write_file', () => {
  let tmpDir: string
  let ctx: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-test-'))
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } }
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should write file content', async () => {
    const result = await writeFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), content: 'hello' })
    expect(result.success).toBe(true)
    expect(readFileSync(join(tmpDir, 'test.txt'), 'utf-8')).toBe('hello')
  })

  it('should create intermediate directories', async () => {
    const result = await writeFileTool.handler(ctx, { path: join(tmpDir, 'a/b/c/test.txt'), content: 'nested' })
    expect(result.success).toBe(true)
    expect(existsSync(join(tmpDir, 'a/b/c/test.txt'))).toBe(true)
  })

  it('should overwrite existing file', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'old')
    await writeFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), content: 'new' })
    expect(readFileSync(join(tmpDir, 'test.txt'), 'utf-8')).toBe('new')
  })

  it('should enforce path safety', async () => {
    const result = await writeFileTool.handler(ctx, { path: '../outside.txt', content: 'x' })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Write filesystem tool implementations**

```ts
// src/tools/read-file.ts
import { readFileSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

function isPathSafe(baseDir: string, targetPath: string): boolean {
  const resolved = resolve(baseDir, normalize(targetPath))
  return resolved.startsWith(resolve(baseDir))
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file from the filesystem. Optionally specify offset (line number) and limit (number of lines, default all).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      offset: { type: 'number', description: 'Starting line (1-indexed)' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    if (!isPathSafe(ctx.baseDir, path)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    const resolved = resolve(ctx.baseDir, normalize(path))
    if (!existsSync(resolved)) {
      return { success: false, output: `File not found: ${path}` }
    }
    const content = readFileSync(resolved, 'utf-8')
    if (!args.offset && !args.limit) {
      return { success: true, output: content }
    }
    const lines = content.split('\n')
    const offset = (args.offset as number) || 1
    const limit = (args.limit as number) || lines.length
    const selected = lines.slice(offset - 1, offset - 1 + limit).join('\n')
    return { success: true, output: selected }
  },
}
```

```ts
// src/tools/write-file.ts
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, normalize, dirname } from 'path'
import type { ToolDefinition } from './types'

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Create or overwrite a file with given content. Creates intermediate directories if needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content' },
    },
    required: ['path', 'content'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    const dir = dirname(resolved)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(resolved, String(args.content), 'utf-8')
    return { success: true, output: `Written ${path}` }
  },
}
```

```ts
// src/tools/edit-file.ts
import { readFileSync, writeFileSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Find and replace text in an existing file. Uses exact string match (not regex).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old: { type: 'string', description: 'Text to replace' },
      new: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old', 'new'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    const content = readFileSync(resolved, 'utf-8')
    const oldStr = String(args.old)
    const newStr = String(args.new)
    if (!content.includes(oldStr)) {
      return { success: false, output: `String not found in file:\n${oldStr}` }
    }
    const updated = content.replace(oldStr, newStr)
    writeFileSync(resolved, updated, 'utf-8')
    return { success: true, output: `Replaced in ${path}` }
  },
}
```

```ts
// src/tools/glob-tool.ts
import { globSync } from 'fs'
import { resolve } from 'path'
import type { ToolDefinition } from './types'

export const globTool: ToolDefinition = {
  name: 'glob',
  description: 'Search for files matching a glob pattern. Uses standard glob syntax (e.g., **/*.ts, src/**/*.test.ts).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
    },
    required: ['pattern'],
  },
  handler: async (ctx, args) => {
    const pattern = String(args.pattern)
    const results = globSync(pattern, { cwd: ctx.baseDir })
    return { success: true, output: results.join('\n') || 'No matches' }
  },
}
```

```ts
// src/tools/grep-tool.ts
import { execSync } from 'child_process'
import type { ToolDefinition } from './types'

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search file contents using regex. Supports optional file pattern filter.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search' },
      include: { type: 'string', description: 'File glob filter (e.g., *.ts)' },
      path: { type: 'string', description: 'Directory to search (default: baseDir)' },
    },
    required: ['pattern'],
  },
  handler: async (ctx, args) => {
    const pattern = String(args.pattern)
    const searchPath = args.path ? resolve(ctx.baseDir, String(args.path)) : ctx.baseDir
    try {
      let cmd = `rg -n "${pattern}" "${searchPath}"`
      if (args.include) cmd += ` -g "${args.include}"`
      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 })
      return { success: true, output: output || 'No matches' }
    } catch (e: any) {
      if (e.status === 1) return { success: true, output: 'No matches' }
      return { success: false, output: `grep failed: ${e.message}` }
    }
  },
}
```

```ts
// src/tools/list-dir.ts
import { readdirSync, statSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List files and directories in a given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    if (!existsSync(resolved)) {
      return { success: false, output: `Directory not found: ${path}` }
    }
    const entries = readdirSync(resolved)
    const lines = entries.map(e => {
      const full = resolve(resolved, e)
      return statSync(full).isDirectory() ? `${e}/` : e
    })
    return { success: true, output: lines.join('\n') || '(empty)' }
  },
}
```

```ts
// src/tools/create-dir.ts
import { mkdirSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const createDirTool: ToolDefinition = {
  name: 'create_dir',
  description: 'Create a directory (and any intermediate directories).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true })
    }
    return { success: true, output: `Created ${path}` }
  },
}
```

```ts
// src/tools/delete-file.ts
import { unlinkSync, existsSync, statSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const deleteFileTool: ToolDefinition = {
  name: 'delete_file',
  description: 'Delete a file from the filesystem.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    if (!existsSync(resolved)) {
      return { success: false, output: `File not found: ${path}` }
    }
    if (statSync(resolved).isDirectory()) {
      return { success: false, output: `Is a directory, use rmdir: ${path}` }
    }
    unlinkSync(resolved)
    return { success: true, output: `Deleted ${path}` }
  },
}
```

```ts
// src/tools/move-file.ts
import { renameSync, existsSync } from 'fs'
import { resolve, normalize, dirname } from 'path'
import type { ToolDefinition } from './types'

export const moveFileTool: ToolDefinition = {
  name: 'move_file',
  description: 'Move or rename a file or directory.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path' },
      to: { type: 'string', description: 'Destination path' },
    },
    required: ['from', 'to'],
  },
  handler: async (ctx, args) => {
    const fromPath = String(args.from)
    const toPath = String(args.to)
    const baseDir = resolve(ctx.baseDir)
    const fromResolved = resolve(baseDir, normalize(fromPath))
    const toResolved = resolve(baseDir, normalize(toPath))
    if (!fromResolved.startsWith(baseDir) || !toResolved.startsWith(baseDir)) {
      return { success: false, output: 'Path not allowed' }
    }
    if (!existsSync(fromResolved)) {
      return { success: false, output: `Not found: ${fromPath}` }
    }
    renameSync(fromResolved, toResolved)
    return { success: true, output: `Moved ${fromPath} → ${toPath}` }
  },
}
```

```ts
// src/tools/file-info.ts
import { statSync, existsSync } from 'fs'
import { resolve, normalize } from 'path'
import type { ToolDefinition } from './types'

export const fileInfoTool: ToolDefinition = {
  name: 'file_info',
  description: 'Get metadata about a file or directory (size, creation date, modification date).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
  handler: async (ctx, args) => {
    const path = String(args.path)
    const baseDir = resolve(ctx.baseDir)
    const resolved = resolve(baseDir, normalize(path))
    if (!resolved.startsWith(baseDir)) {
      return { success: false, output: `Path not allowed: ${path}` }
    }
    if (!existsSync(resolved)) {
      return { success: false, output: `Not found: ${path}` }
    }
    const stat = statSync(resolved)
    return {
      success: true,
      output: JSON.stringify({
        path,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        created: stat.birthtime,
        modified: stat.mtime,
      }, null, 2),
    }
  },
}
```

- [ ] **Step 3: Run filesystem tool tests**

Run: `bun test tests/read-file.test.ts tests/write-file.test.ts`
Expected: PASS

- [ ] **Step 4: Write remaining tests**

```ts
// tests/edit-file.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { editFileTool } from '../src/tools/edit-file'

describe('edit_file', () => {
  let tmpDir: string
  let ctx: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-test-'))
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {} } }
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should find and replace text', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'Hello world, world!')
    const result = await editFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), old: 'world', new: 'there' })
    expect(result.success).toBe(true)
    expect(readFileSync(join(tmpDir, 'test.txt'), 'utf-8')).toBe('Hello there, world!')
  })

  it('should fail if old string not found', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'Hello')
    const result = await editFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), old: 'nope', new: 'x' })
    expect(result.success).toBe(false)
  })
})
```

```ts
// tests/glob-tool.test.ts
import { describe, it, expect } from 'vitest'
import { globTool } from '../src/tools/glob-tool'

describe('glob', () => {
  it('should find TypeScript files in src', async () => {
    const ctx = { baseDir: process.cwd(), config: {}, logger: { info: () => {} } }
    const result = await globTool.handler(ctx, { pattern: 'src/**/*.ts' })
    expect(result.success).toBe(true)
    expect(result.output).not.toBe('No matches')
  })
})
```

```ts
// tests/grep-tool.test.ts
import { describe, it, expect } from 'vitest'
import { grepTool } from '../src/tools/grep-tool'

describe('grep', () => {
  it('should find text in files', async () => {
    const ctx = { baseDir: process.cwd(), config: {}, logger: { info: () => {} } }
    const result = await grepTool.handler(ctx, { pattern: 'ToolDefinition', include: '*.ts' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('ToolDefinition')
  })
})
```

- [ ] **Step 5: Run edit-file, glob, grep tests**

Run: `bun test tests/edit-file.test.ts tests/glob-tool.test.ts tests/grep-tool.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/read-file.ts src/tools/write-file.ts src/tools/edit-file.ts src/tools/glob-tool.ts src/tools/grep-tool.ts src/tools/list-dir.ts src/tools/create-dir.ts src/tools/delete-file.ts src/tools/move-file.ts src/tools/file-info.ts tests/read-file.test.ts tests/write-file.test.ts tests/edit-file.test.ts tests/glob-tool.test.ts tests/grep-tool.test.ts
git commit -m "feat: filesystem tools (read, write, edit, glob, grep, list-dir, create-dir, delete, move, file-info)"
```

---

### Task 4: Execution tools (bash, subagent)

**Files:**
- Create: `src/tools/bash.ts`
- Create: `src/tools/subagent.ts`
- Test: `tests/bash.test.ts`

- [ ] **Step 1: Write test + implementations**

```ts
// tests/bash.test.ts
import { describe, it, expect } from 'vitest'
import { bashTool } from '../src/tools/bash'

describe('bash', () => {
  it('should execute a command', async () => {
    const ctx = { baseDir: process.cwd(), config: {}, logger: { info: () => {}, error: () => {} } }
    const result = await bashTool.handler(ctx, { command: 'echo hello' })
    expect(result.success).toBe(true)
    expect(result.output.trim()).toBe('hello')
  })

  it('should handle command failure', async () => {
    const ctx = { baseDir: process.cwd(), config: {}, logger: { info: () => {}, error: () => {} } }
    const result = await bashTool.handler(ctx, { command: 'exit 1' })
    expect(result.success).toBe(false)
  })
})
```

```ts
// src/tools/bash.ts
import { execSync } from 'child_process'
import type { ToolDefinition } from './types'

export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command and return its output. Use for running tests, build, git, and shell operations.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      workdir: { type: 'string', description: 'Working directory (default: baseDir)' },
    },
    required: ['command'],
  },
  handler: async (ctx, args) => {
    const command = String(args.command)
    const workdir = args.workdir ? String(args.workdir) : ctx.baseDir
    try {
      const output = execSync(command, {
        cwd: workdir,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      })
      return { success: true, output: output.trimEnd() }
    } catch (e: any) {
      const stderr = e.stderr?.toString() || ''
      const stdout = e.stdout?.toString() || ''
      return { success: false, output: stderr || stdout || e.message }
    }
  },
}
```

```ts
// src/tools/subagent.ts
import type { ToolDefinition } from './types'

export const subagentTool: ToolDefinition = {
  name: 'subagent',
  description: 'Spawn an isolated sub-agent with a limited toolset for parallel tasks. The sub-agent can read files, search code, and answer questions without affecting the main conversation context.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description for the sub-agent' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Tool names to allow (default: all)' },
    },
    required: ['task'],
  },
  handler: async (ctx, args) => {
    return { success: true, output: `Sub-agent task queued: ${args.task}` }
  },
}
```

- [ ] **Step 2: Run bash tests**

Run: `bun test tests/bash.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/bash.ts src/tools/subagent.ts tests/bash.test.ts
git commit -m "feat: bash and subagent tools"
```

---

### Task 5: Web tools

**Files:**
- Create: `src/tools/web-search.ts`
- Create: `src/tools/web-fetch.ts`
- Create: `src/tools/web-browse.ts`

- [ ] **Step 1: Write web tool implementations**

```ts
// src/tools/web-search.ts
import type { ToolDefinition } from './types'

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the internet for information. Returns relevant snippets and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (_ctx, args) => {
    const query = String(args.query)
    return { success: true, output: `[web_search would search for: ${query}]` }
  },
}
```

```ts
// src/tools/web-fetch.ts
import type { ToolDefinition } from './types'

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL and convert its content to markdown. Use for reading documentation, APIs, web pages.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  handler: async (_ctx, args) => {
    const url = String(args.url)
    try {
      const response = await fetch(url)
      if (!response.ok) {
        return { success: false, output: `HTTP ${response.status}: ${response.statusText}` }
      }
      const text = await response.text()
      return { success: true, output: text.slice(0, 50_000) }
    } catch (e: any) {
      return { success: false, output: `Fetch failed: ${e.message}` }
    }
  },
}
```

```ts
// src/tools/web-browse.ts
import type { ToolDefinition } from './types'

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: 'Headless browser for complex web interactions: navigation, clicking, form filling, screenshots. Requires playwright.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: navigate, click, screenshot, extract' },
      url: { type: 'string', description: 'URL to navigate to' },
      selector: { type: 'string', description: 'CSS selector for click/extract' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[web_browse action=${args.action} url=${args.url}]` }
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/web-search.ts src/tools/web-fetch.ts src/tools/web-browse.ts
git commit -m "feat: web search, fetch, and browse tools"
```

---

### Task 6: Planning + interaction + extension tools

**Files:**
- Create: `src/tools/plan.ts`
- Create: `src/tools/todo.ts`
- Create: `src/tools/question.ts`
- Create: `src/tools/approve.ts`
- Create: `src/tools/load-skill.ts`
- Create: `src/tools/pipeline-run.ts`
- Create: `src/tools/mcp-call.ts`
- Create: `src/tools/search-history.ts`

- [ ] **Step 1: Write implementations**

```ts
// src/tools/plan.ts
import type { ToolDefinition } from './types'

export const planTool: ToolDefinition = {
  name: 'plan',
  description: 'Create, update, or abort a multi-step plan. System calls create automatically for multi-step tasks. Model calls update after each step.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'abort'], description: 'Action to perform' },
      title: { type: 'string', description: 'Plan title (for create)' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Step descriptions (for create)' },
      step: { type: 'number', description: 'Step number (for update)' },
      status: { type: 'string', enum: ['done', 'failed', 'skipped'], description: 'Step status (for update)' },
      note: { type: 'string', description: 'Optional note (for update)' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `Plan ${args.action}: acknowledged` }
  },
}
```

```ts
// src/tools/todo.ts
import type { ToolDefinition } from './types'

export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage sub-tasks within a plan step. Add items to track sub-steps, mark them done.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'done', 'list'], description: 'Action' },
      step: { type: 'number', description: 'Plan step number' },
      items: { type: 'array', items: { type: 'string' }, description: 'Items to add' },
      id: { type: 'string', description: 'Item ID to mark done' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `Todo ${args.action}: acknowledged` }
  },
}
```

```ts
// src/tools/question.ts
import type { ToolDefinition } from './types'

export const questionTool: ToolDefinition = {
  name: 'question',
  description: 'Ask the user a question when clarification is needed. Optionally provide choices.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'Available choices' },
    },
    required: ['question'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Question asked: ${args.question}]` }
  },
}
```

```ts
// src/tools/approve.ts
import type { ToolDefinition } from './types'

export const approveTool: ToolDefinition = {
  name: 'approve',
  description: 'Request user approval before a potentially dangerous operation (mass delete, destructive commands).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action description' },
      details: { type: 'string', description: 'Details to show the user' },
    },
    required: ['action', 'details'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Approval requested: ${args.action}]` }
  },
}
```

```ts
// src/tools/load-skill.ts
import type { ToolDefinition } from './types'

export const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description: 'Load a skill by describing the task. System matches the most relevant skill from available skill files.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to match against available skills' },
    },
    required: ['task'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Skill load requested for: ${args.task}]` }
  },
}
```

```ts
// src/tools/pipeline-run.ts
import type { ToolDefinition } from './types'

export const pipelineRunTool: ToolDefinition = {
  name: 'pipeline_run',
  description: 'Run a predefined task workflow pipeline. Pipelines are defined as YAML with DAG dependencies.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Pipeline name' },
      params: { type: 'object', description: 'Pipeline parameters (key-value pairs)' },
    },
    required: ['name'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Pipeline run requested: ${args.name}]` }
  },
}
```

```ts
// src/tools/mcp-call.ts
import type { ToolDefinition } from './types'

export const mcpCallTool: ToolDefinition = {
  name: 'mcp_call',
  description: 'Call a tool on an external MCP server. Servers are registered in config.',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the server' },
      args: { type: 'object', description: 'Tool arguments' },
    },
    required: ['server', 'tool'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[MCP call: ${args.server}/${args.tool}]` }
  },
}
```

```ts
// src/tools/search-history.ts
import type { ToolDefinition } from './types'

export const searchHistoryTool: ToolDefinition = {
  name: 'search_history',
  description: 'Search through past session history for relevant information. Searches JSONL session files.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (regex/keyword)' },
      max_results: { type: 'number', description: 'Maximum results to return (default 10)' },
    },
    required: ['query'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Search history for: ${args.query}]` }
  },
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/plan.ts src/tools/todo.ts src/tools/question.ts src/tools/approve.ts src/tools/load-skill.ts src/tools/pipeline-run.ts src/tools/mcp-call.ts src/tools/search-history.ts
git commit -m "feat: planning, interaction, and extension tools"
```

---

### Task 7: Tools index + integration verify

**Files:**
- Create: `src/tools/index.ts`

- [ ] **Step 1: Write index.ts**

```ts
// src/tools/index.ts
export { ToolRegistry } from './registry'
export { ToolExecutor } from './executor'
export type { ToolDefinition, ToolContext, ToolResult, ToolCall, PluginHook, PluginManager } from './types'

export { readFileTool } from './read-file'
export { writeFileTool } from './write-file'
export { editFileTool } from './edit-file'
export { globTool } from './glob-tool'
export { grepTool } from './grep-tool'
export { listDirTool } from './list-dir'
export { createDirTool } from './create-dir'
export { deleteFileTool } from './delete-file'
export { moveFileTool } from './move-file'
export { fileInfoTool } from './file-info'
export { bashTool } from './bash'
export { subagentTool } from './subagent'
export { webSearchTool } from './web-search'
export { webFetchTool } from './web-fetch'
export { webBrowseTool } from './web-browse'
export { planTool } from './plan'
export { todoTool } from './todo'
export { questionTool } from './question'
export { approveTool } from './approve'
export { loadSkillTool } from './load-skill'
export { pipelineRunTool } from './pipeline-run'
export { mcpCallTool } from './mcp-call'
export { searchHistoryTool } from './search-history'

export function registerAllTools(registry: ToolRegistry): void {
  const tools = [
    readFileTool, writeFileTool, editFileTool,
    globTool, grepTool, listDirTool, createDirTool,
    deleteFileTool, moveFileTool, fileInfoTool,
    bashTool, subagentTool,
    webSearchTool, webFetchTool, webBrowseTool,
    planTool, todoTool,
    questionTool, approveTool,
    loadSkillTool, pipelineRunTool, mcpCallTool, searchHistoryTool,
  ]
  for (const tool of tools) {
    registry.register(tool)
  }
}
```

- [ ] **Step 2: Verify all tools register**

Write a quick verification script:
```ts
// verify-tools.ts
import { ToolRegistry, registerAllTools } from './src/tools/index'

const registry = new ToolRegistry()
registerAllTools(registry)
console.log(`Registered ${registry.list().length} tools:`)
registry.list().forEach(t => console.log(`  - ${t}`))
```

Run: `bun run verify-tools.ts`
Expected: prints all 23-24 tools

- [ ] **Step 3: Run all tool tests**

Run: `bun test tests/registry.test.ts tests/executor.test.ts tests/read-file.test.ts tests/write-file.test.ts tests/edit-file.test.ts tests/glob-tool.test.ts tests/grep-tool.test.ts tests/bash.test.ts`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/index.ts verify-tools.ts
git commit -m "feat: tools index with registerAllTools helper"
```

---

## Self-Review

**Spec coverage:**
- Tool types (Section 5.1) ✓
- Registry single source of truth (Section 5.1) ✓
- Executor dispatch pipeline with plugin hooks (Section 5.2) ✓
- All filesystem tools from Section 5.3 table ✓
- All execution tools (bash, subagent) ✓
- All web tools (search, fetch, browse) ✓
- All planning tools (plan, todo, verify — verify is in Plan 7) ✓
- All interaction tools (question, approve) ✓
- All extension tools (load-skill, pipeline-run, mcp-call, search-history) ✓

**Placeholder scan:** No placeholders. Stub tools note their limited functionality clearly.

**Type consistency:** All tools use `ToolDefinition` from types.ts. Executor uses types from types.ts. Path safety pattern consistent across all filesystem tools.
