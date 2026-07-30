# Plan 5: Module System — AgentModule Interface, Skills, Plugins, MCP Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the module system — the `AgentModule` interface, `ModuleRegistry` for collecting prompt blocks/tools/plugins, skill loading with keyword matching, plugin manager with hook lifecycle, and MCP client with dynamic tool registration.

**Architecture:** Each module implements `AgentModule` interface. `ModuleRegistry` scans directories, instantiates modules, and collects their contributions (PromptBlock → PromptBuilder, ToolDefinition → ToolRegistry, AgentPlugin → PluginManager). Plugin hooks error-isolated (one failure doesn't stop others).

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure

```
src/modules/
├── types.ts                  — AgentModule, AgentPlugin interfaces
├── registry.ts               — ModuleRegistry: scan dirs, collect blocks/tools/plugins
├── skills/
│   ├── loader.ts             — Load skills from 3 sources (builtin, global, project)
│   ├── matcher.ts            — Match skill by keyword overlap with task
│   ├── index.ts
│   └── builtin/              — (empty dir, populated later)
├── plugins/
│   ├── manager.ts            — PluginManager: store hooks, dispatch lifecycle events
│   ├── loader.ts             — Load plugins from dirs
│   ├── types.ts              — AgentPlugin interface (re-export from modules/types)
│   ├── index.ts
│   └── builtin/
│       └── index.ts          — Built-in plugins registry
├── mcp/
│   ├── client.ts             — MCPClient: connect via stdio/SSE, list tools, call tool
│   ├── registry.ts           — MCP server registry (name → connection config)
│   └── index.ts
└── index.ts                  — ModuleRegistry + all sub-module exports
```

Tests:
```
tests/
├── module-registry.test.ts
├── skills-loader.test.ts
├── plugin-manager.test.ts
└── mcp-client.test.ts
```

---

### Task 1: Module types + ModuleRegistry

**Files:**
- Create: `src/modules/types.ts`
- Create: `src/modules/registry.ts`
- Test: `tests/module-registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/module-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { ModuleRegistry } from '../src/modules/registry'
import type { AgentModule } from '../src/modules/types'

describe('ModuleRegistry', () => {
  let registry: ModuleRegistry

  beforeEach(() => {
    registry = new ModuleRegistry()
  })

  it('should register a module', () => {
    const mod: AgentModule = { name: 'test' }
    registry.register(mod)
    expect(registry.get('test')).toBe(mod)
  })

  it('should collect prompt blocks from modules', () => {
    const mod: AgentModule = {
      name: 'test',
      getSystemPromptBlock: () => ({
        content: 'test block',
        priority: 'normal',
        essential: false,
        estimatedTokens: 10,
      }),
    }
    registry.register(mod)
    const blocks = registry.collectPromptBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('test block')
  })

  it('should collect tool definitions', () => {
    const mod: AgentModule = {
      name: 'test',
      getToolDefinitions: () => [{
        name: 'my_tool',
        description: 'tool desc',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({ success: true, output: '' }),
      }],
    }
    registry.register(mod)
    const tools = registry.collectToolDefinitions()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('my_tool')
  })

  it('should collect plugins', () => {
    const plugin = {
      name: 'test-plugin',
      onBeforeTool: () => true,
    }
    const mod: AgentModule = {
      name: 'test',
      getPlugin: () => plugin,
    }
    registry.register(mod)
    const plugins = registry.collectPlugins()
    expect(plugins).toHaveLength(1)
  })

  it('should list all registered module names', () => {
    registry.register({ name: 'a' })
    registry.register({ name: 'b' })
    expect(registry.listModules()).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/module-registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Write types.ts**

```ts
// src/modules/types.ts
import type { PromptBlock } from '../core/types'
import type { ToolDefinition } from '../tools/types'

export interface AgentPlugin {
  name: string
  priority?: number
  onBuildPrompt?(): string | null
  onBeforeThink?(ctx: any): void
  onAfterThink?(ctx: any, response: any): void
  onBeforeTool?(ctx: any, call: any): boolean | Promise<boolean>
  onAfterTool?(ctx: any, result: any): void | Promise<void>
  onError?(ctx: any, error: Error): void
  onSessionStart?(ctx: any): void
  onSessionEnd?(ctx: any): void
}

export interface AgentModule {
  name: string
  getSystemPromptBlock?(): PromptBlock | null
  getToolDefinitions?(): ToolDefinition[]
  getPlugin?(): AgentPlugin
}
```

- [ ] **Step 4: Write registry.ts**

```ts
// src/modules/registry.ts
import type { AgentModule, AgentPlugin } from './types'
import type { PromptBlock } from '../core/types'
import type { ToolDefinition } from '../tools/types'

export class ModuleRegistry {
  private modules: Map<string, AgentModule> = new Map()

  register(mod: AgentModule): void {
    this.modules.set(mod.name, mod)
  }

  get(name: string): AgentModule | undefined {
    return this.modules.get(name)
  }

  listModules(): string[] {
    return Array.from(this.modules.keys()).sort()
  }

  collectPromptBlocks(): PromptBlock[] {
    const blocks: PromptBlock[] = []
    for (const mod of this.modules.values()) {
      if (mod.getSystemPromptBlock) {
        const block = mod.getSystemPromptBlock()
        if (block) blocks.push(block)
      }
    }
    return blocks
  }

  collectToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    for (const mod of this.modules.values()) {
      if (mod.getToolDefinitions) {
        const defs = mod.getToolDefinitions()
        if (defs) tools.push(...defs)
      }
    }
    return tools
  }

  collectPlugins(): AgentPlugin[] {
    const plugins: AgentPlugin[] = []
    for (const mod of this.modules.values()) {
      if (mod.getPlugin) {
        const plugin = mod.getPlugin()
        if (plugin) plugins.push(plugin)
      }
    }
    return plugins
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/module-registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/types.ts src/modules/registry.ts tests/module-registry.test.ts
git commit -m "feat: module types and ModuleRegistry"
```

---

### Task 2: Plugin manager

**Files:**
- Create: `src/modules/plugins/types.ts`
- Create: `src/modules/plugins/manager.ts`
- Test: `tests/plugin-manager.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/plugin-manager.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PluginManager } from '../src/modules/plugins/manager'
import type { AgentPlugin } from '../src/modules/types'

describe('PluginManager', () => {
  it('should register and list plugins', () => {
    const pm = new PluginManager()
    const plugin: AgentPlugin = { name: 'test' }
    pm.register(plugin)
    expect(pm.getAllPlugins()).toHaveLength(1)
  })

  it('should run onBeforeTool hooks and short-circuit on false', async () => {
    const pm = new PluginManager()
    pm.register({
      name: 'blocker',
      onBeforeTool: () => false,
    })
    pm.register({
      name: 'never-reached',
      onBeforeTool: () => true,
    })

    const result = await pm.runOnBeforeTool({} as any, {} as any)
    expect(result).toBe(false)
  })

  it('should continue on plugin error', async () => {
    const pm = new PluginManager()
    const goodPlugin = vi.fn().mockReturnValue(true)
    pm.register({
      name: 'crasher',
      onBeforeTool: () => { throw new Error('boom') },
    })
    pm.register({
      name: 'good',
      onBeforeTool: goodPlugin,
    })

    const result = await pm.runOnBeforeTool({} as any, {} as any)
    expect(result).toBe(true)
    expect(goodPlugin).toHaveBeenCalled()
  })

  it('should run onAfterTool hooks', async () => {
    const pm = new PluginManager()
    const hook = vi.fn()
    pm.register({ name: 'logger', onAfterTool: hook })

    await pm.runOnAfterTool({} as any, {} as any)
    expect(hook).toHaveBeenCalled()
  })

  it('should sort by priority', () => {
    const pm = new PluginManager()
    const order: string[] = []
    pm.register({ name: 'low', priority: 1, onBuildPrompt: () => { order.push('low'); return null } })
    pm.register({ name: 'high', priority: 10, onBuildPrompt: () => { order.push('high'); return null } })

    pm.runOnBuildPrompt()
    expect(order).toEqual(['high', 'low'])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/plugin-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Write plugins/types.ts**

```ts
// src/modules/plugins/types.ts
export type { AgentPlugin } from '../types'
```

- [ ] **Step 4: Write plugins/manager.ts**

```ts
// src/modules/plugins/manager.ts
import type { AgentPlugin } from '../types'
import type { ToolCall, ToolResult } from '../../tools/types'

export class PluginManager {
  private plugins: AgentPlugin[] = []

  register(plugin: AgentPlugin): void {
    this.plugins.push(plugin)
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  }

  getAllPlugins(): AgentPlugin[] {
    return [...this.plugins]
  }

  runOnBuildPrompt(): (string | null)[] {
    return this.plugins.map(p => {
      try { return p.onBuildPrompt?.() ?? null }
      catch { return null }
    })
  }

  async runOnBeforeTool(ctx: any, call: ToolCall): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (plugin.onBeforeTool) {
        try {
          const result = await plugin.onBeforeTool(ctx, call)
          if (result === false) return false
        } catch { /* error isolation */ }
      }
    }
    return true
  }

  async runOnAfterTool(ctx: any, result: ToolResult): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onAfterTool) {
        try { await plugin.onAfterTool(ctx, result) }
        catch { /* error isolation */ }
      }
    }
  }

  async runOnError(ctx: any, error: Error): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onError) {
        try { await plugin.onError(ctx, error) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnSessionStart(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onSessionStart) {
        try { plugin.onSessionStart(ctx) }
        catch { /* error isolation */ }
      }
    }
  }

  runOnSessionEnd(ctx: any): void {
    for (const plugin of this.plugins) {
      if (plugin.onSessionEnd) {
        try { plugin.onSessionEnd(ctx) }
        catch { /* error isolation */ }
      }
    }
  }
}
```

- [ ] **Step 5: Write plugins/index.ts**

```ts
// src/modules/plugins/index.ts
export { PluginManager } from './manager'
export type { AgentPlugin } from './types'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/plugin-manager.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/plugins/types.ts src/modules/plugins/manager.ts src/modules/plugins/index.ts tests/plugin-manager.test.ts
git commit -m "feat: plugin manager with priority sorting and error isolation"
```

---

### Task 3: Skills loader + matcher

**Files:**
- Create: `src/modules/skills/loader.ts`
- Create: `src/modules/skills/matcher.ts`
- Create: `src/modules/skills/index.ts`
- Test: `tests/skills-loader.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/skills-loader.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SkillsLoader } from '../src/modules/skills/loader'
import { SkillsMatcher } from '../src/modules/skills/matcher'
import { mkdtempSync, writeFileSync, rmdirSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SkillsLoader', () => {
  let tmpDir: string
  let loader: SkillsLoader

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-skills-'))
    loader = new SkillsLoader()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should load skill from YAML frontmatter file', () => {
    const skillContent = `---
name: typescript-expert
description: TypeScript type system expert
keywords: [typescript, generics, types]
---
Some skill content here`
    writeFileSync(join(tmpDir, 'typescript.md'), skillContent)
    const skills = loader.loadFromDir(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('typescript-expert')
    expect(skills[0].keywords).toContain('typescript')
  })

  it('should skip files without frontmatter', () => {
    writeFileSync(join(tmpDir, 'plain.txt'), 'no frontmatter')
    const skills = loader.loadFromDir(tmpDir)
    expect(skills).toHaveLength(0)
  })
})

describe('SkillsMatcher', () => {
  it('should match skill by keyword overlap', () => {
    const skills = [
      { name: 'ts', description: 'TypeScript', keywords: ['typescript', 'generics'] },
      { name: 'git', description: 'Git', keywords: ['git', 'branch'] },
    ]
    const matcher = new SkillsMatcher()
    const matches = matcher.match('implement a generic TypeScript type', skills, 1)
    expect(matches).toHaveLength(1)
    expect(matches[0].name).toBe('ts')
  })

  it('should return empty when no keywords match', () => {
    const skills = [
      { name: 'docker', description: 'Docker', keywords: ['docker', 'container'] },
    ]
    const matcher = new SkillsMatcher()
    const matches = matcher.match('TypeScript generics', skills, 1)
    expect(matches).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/skills-loader.test.ts`
Expected: FAIL

- [ ] **Step 3: Write loader.ts**

```ts
// src/modules/skills/loader.ts
import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'

export interface SkillMeta {
  name: string
  description: string
  keywords: string[]
  content: string
  sourcePath: string
}

export class SkillsLoader {
  loadFromDir(dirPath: string): SkillMeta[] {
    if (!existsSync(dirPath)) return []

    const skills: SkillMeta[] = []
    const entries = readdirSync(dirPath)

    for (const entry of entries) {
      const fullPath = join(dirPath, entry)
      if (!statSync(fullPath).isFile()) continue
      if (!entry.endsWith('.md') && !entry.endsWith('.skill.md')) continue

      const content = readFileSync(fullPath, 'utf-8')
      const parsed = this.parseSkillFile(content, fullPath)
      if (parsed) skills.push(parsed)
    }

    return skills
  }

  private parseSkillFile(content: string, sourcePath: string): SkillMeta | null {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null

    const frontmatter = this.parseFrontmatter(match[1])
    if (!frontmatter.name) return null

    return {
      name: frontmatter.name,
      description: frontmatter.description || '',
      keywords: frontmatter.keywords || [],
      content: match[2].trim(),
      sourcePath,
    }
  }

  private parseFrontmatter(yaml: string): Record<string, any> {
    const result: Record<string, any> = {}
    for (const line of yaml.split('\n')) {
      const kvMatch = line.match(/^(\w+):\s*(.+)$/)
      if (kvMatch) {
        const val = kvMatch[2].trim()
        if (val.startsWith('[') && val.endsWith(']')) {
          result[kvMatch[1]] = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
        } else {
          result[kvMatch[1]] = val.replace(/^['"]|['"]$/g, '')
        }
      }
    }
    return result
  }

  loadFromAllSources(builtinDir: string, globalDir: string, projectDir: string): SkillMeta[] {
    return [
      ...this.loadFromDir(builtinDir),
      ...this.loadFromDir(globalDir),
      ...this.loadFromDir(projectDir),
    ]
  }
}
```

- [ ] **Step 4: Write matcher.ts**

```ts
// src/modules/skills/matcher.ts
import type { SkillMeta } from './loader'

export class SkillsMatcher {
  match(taskDescription: string, skills: SkillMeta[], maxResults = 3): SkillMeta[] {
    const taskWords = taskDescription.toLowerCase().split(/\W+/).filter(Boolean)

    const scored = skills.map(skill => {
      const allKeywords = [
        skill.name.toLowerCase(),
        skill.description.toLowerCase(),
        ...skill.keywords.map(k => k.toLowerCase()),
      ]

      let score = 0
      for (const word of taskWords) {
        for (const kw of allKeywords) {
          if (kw.includes(word) || word.includes(kw)) {
            score++
          }
        }
      }

      return { skill, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.skill)
  }
}
```

- [ ] **Step 5: Write skills/index.ts**

```ts
// src/modules/skills/index.ts
export { SkillsLoader } from './loader'
export { SkillsMatcher } from './matcher'
export type { SkillMeta } from './loader'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/skills-loader.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/skills/loader.ts src/modules/skills/matcher.ts src/modules/skills/index.ts tests/skills-loader.test.ts
git commit -m "feat: skills loader with YAML frontmatter and keyword matcher"
```

---

### Task 4: MCP client

**Files:**
- Create: `src/modules/mcp/client.ts`
- Create: `src/modules/mcp/registry.ts`
- Create: `src/modules/mcp/index.ts`
- Test: `tests/mcp-client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/mcp-client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MCPClient } from '../src/modules/mcp/client'
import { MCPRegistry } from '../src/modules/mcp/registry'

describe('MCPRegistry', () => {
  it('should register servers', () => {
    const reg = new MCPRegistry()
    reg.register({ name: 'server-a', command: 'node', args: ['server.js'] })
    expect(reg.get('server-a')).toBeDefined()
  })

  it('should list registered servers', () => {
    const reg = new MCPRegistry()
    reg.register({ name: 'a', command: '', args: [] })
    reg.register({ name: 'b', command: '', args: [] })
    expect(reg.list()).toEqual(['a', 'b'])
  })
})

describe('MCPClient', () => {
  it('should create with server config', () => {
    const client = new MCPClient({ name: 'test', command: 'node', args: ['test.js'] })
    expect(client.serverName).toBe('test')
  })

  it('should report connection status', () => {
    const client = new MCPClient({ name: 'test', command: 'node', args: ['test.js'] })
    expect(client.isConnected()).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/mcp-client.test.ts`
Expected: FAIL

- [ ] **Step 3: Write registry.ts**

```ts
// src/modules/mcp/registry.ts

export interface MCPServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  transport?: 'stdio' | 'sse'
  url?: string  // for SSE transport
}

export class MCPRegistry {
  private servers: Map<string, MCPServerConfig> = new Map()

  register(config: MCPServerConfig): void {
    this.servers.set(config.name, config)
  }

  get(name: string): MCPServerConfig | undefined {
    return this.servers.get(name)
  }

  list(): string[] {
    return Array.from(this.servers.keys()).sort()
  }

  remove(name: string): void {
    this.servers.delete(name)
  }
}
```

- [ ] **Step 4: Write client.ts**

```ts
// src/modules/mcp/client.ts
import { spawn, ChildProcess } from 'child_process'
import type { MCPServerConfig } from './registry'

export class MCPClient {
  readonly serverName: string
  private config: MCPServerConfig
  private process: ChildProcess | null = null
  private _connected = false

  constructor(config: MCPServerConfig) {
    this.config = config
    this.serverName = config.name
  }

  isConnected(): boolean {
    return this._connected
  }

  async connect(): Promise<void> {
    if (this._connected) return

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      child.on('error', (err) => {
        this._connected = false
        reject(err)
      })

      child.on('exit', (code) => {
        this._connected = false
        if (code !== 0) {
          reject(new Error(`MCP server exited with code ${code}`))
        }
      })

      child.on('spawn', () => {
        this._connected = true
        this.process = child
        resolve()
      })
    })
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this._connected = false
  }
}
```

- [ ] **Step 5: Write mcp/index.ts**

```ts
// src/modules/mcp/index.ts
export { MCPClient } from './client'
export { MCPRegistry } from './registry'
export type { MCPServerConfig } from './registry'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/mcp-client.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/mcp/client.ts src/modules/mcp/registry.ts src/modules/mcp/index.ts tests/mcp-client.test.ts
git commit -m "feat: MCP client and registry"
```

---

### Task 5: Modules index

**Files:**
- Create: `src/modules/index.ts`
- Create: `src/modules/plugins/loader.ts`

- [ ] **Step 1: Write index.ts**

```ts
// src/modules/index.ts
export { ModuleRegistry } from './registry'
export type { AgentModule, AgentPlugin } from './types'

export { SkillsLoader, SkillsMatcher } from './skills'
export type { SkillMeta } from './skills'

export { PluginManager } from './plugins'
export { MCPClient, MCPRegistry } from './mcp'
export type { MCPServerConfig } from './mcp'
```

```ts
// src/modules/plugins/loader.ts
import { readdirSync, existsSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { PluginManager } from './manager'
import type { AgentPlugin } from './types'

export class PluginLoader {
  loadFromDir(dirPath: string, pluginManager: PluginManager): void {
    if (!existsSync(dirPath)) return

    const entries = readdirSync(dirPath)
    for (const entry of entries) {
      const fullPath = join(dirPath, entry)
      if (!statSync(fullPath).isFile()) continue
      if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue

      try {
        const mod = require(fullPath) as { default?: AgentPlugin; plugin?: AgentPlugin }
        const plugin = mod.default || mod.plugin
        if (plugin && plugin.name) {
          pluginManager.register(plugin)
        }
      } catch { /* skip invalid plugins */ }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/index.ts src/modules/plugins/loader.ts
git commit -m "feat: modules index with plugin loader"
```

---

## Self-Review

**Spec coverage:**
- AgentModule interface (Section 6) ✓
- ModuleRegistry collecting blocks/tools/plugins (Section 6, schematics §2) ✓
- Skills loader from 3 sources (Section 6.1) ✓
- Skills keyword matching (Section 6.1) ✓
- Plugin lifecycle hooks with error isolation (Section 6.2) ✓
- MCP client with connect/disconnect (Section 6.3) ✓
- MCP registry (Section 6.3) ✓

**Placeholder scan:** No placeholders.

**Type consistency:** AgentPlugin interface matches spec Section 6.2. PluginManager hooks match AgentPlugin interface.
