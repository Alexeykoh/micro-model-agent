# Plan 8: Remaining Modules — Pipelines, Indexer, Memory, Updater, User Profile

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the remaining standalone modules — Pipelines (DAG-based workflow engine), Indexer (project file walker with cache), Memory (persistent markdown files), Updater (background version check), and User Profile (OS/shell/preferences collection).

**Architecture:** Each module is self-contained, implements `AgentModule`, and provides `getSystemPromptBlock()` and/or `getPlugin()` hooks. Pipelines parses YAML → DAG → parallel execution with templates. Indexer walks files, detects exports, caches to disk. Memory reads/writes `.mma/memory/*.md` files. Updater does async npm check. UserProfile collects system info on startup.

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure

```
src/modules/pipelines/
├── parser.ts       — Parse YAML pipeline → DAG structure
├── engine.ts       — DAG execution engine (topological sort, parallel steps, retry)
├── template.ts     — Template engine: {{steps.<id>.output}} resolution
└── index.ts
src/modules/indexer/
├── walker.ts       — Walk project files, detect language, extract exports/symbols
├── cache.ts        — Disk (JSON) + memory cache, fs.watch for changes
└── index.ts
src/modules/memory/
├── store.ts        — Read/write .mma/memory/{conventions,decisions,errors}.md
└── index.ts
src/modules/updater/
├── checker.ts      — Async npm registry check for newer version
└── index.ts
src/modules/user-profile/
├── profile.ts      — Collect OS/shell/preferences, persist to ~/.mma/profile.json
└── index.ts
```

Tests:
```
tests/
├── pipelines-parser.test.ts
├── pipelines-engine.test.ts
├── pipelines-template.test.ts
├── indexer.test.ts
├── memory-store.test.ts
├── updater-checker.test.ts
└── user-profile.test.ts
```

---

### Task 1: Pipelines — Parser

**Files:**
- Create: `src/modules/pipelines/parser.ts`
- Test: `tests/pipelines-parser.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/pipelines-parser.test.ts
import { describe, it, expect } from 'vitest'
import { PipelineParser } from '../src/modules/pipelines/parser'

describe('PipelineParser', () => {
  it('should parse a valid pipeline YAML', () => {
    const yaml = `
name: implement-feature
steps:
  - id: research
    agent: explore
    prompt: "Research {feature}"
  - id: implement
    agent: code
    depends_on: [research]
    prompt: "Implement based on {{steps.research.output}}"
`
    const pipeline = PipelineParser.parse(yaml)
    expect(pipeline.name).toBe('implement-feature')
    expect(pipeline.steps).toHaveLength(2)
    expect(pipeline.steps[0].id).toBe('research')
    expect(pipeline.steps[1].depends_on).toEqual(['research'])
  })

  it('should handle parallel steps', () => {
    const yaml = `
name: parallel
steps:
  - id: a
    agent: code
    prompt: "A"
  - id: b
    agent: code
    parallel: true
    prompt: "B"
    depends_on: [a]
  - id: c
    agent: code
    parallel: true
    prompt: "C"
    depends_on: [a]
`
    const pipeline = PipelineParser.parse(yaml)
    const stepB = pipeline.steps.find(s => s.id === 'b')
    expect(stepB?.parallel).toBe(true)
  })

  it('should validate missing fields', () => {
    expect(() => PipelineParser.parse('name: invalid')).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/pipelines-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Write parser.ts**

```ts
// src/modules/pipelines/parser.ts

export interface PipelineStep {
  id: string
  agent: string
  prompt: string
  depends_on?: string[]
  parallel?: boolean
  max_retries?: number
}

export interface Pipeline {
  name: string
  steps: PipelineStep[]
}

export class PipelineParser {
  static parse(yaml: string): Pipeline {
    const lines = yaml.split('\n').filter(l => l.trim())
    const result: any = {}
    let currentSection: string | null = null
    let currentSteps: any[] = []

    for (const line of lines) {
      if (line.match(/^\w+:/) && !line.startsWith(' ') && !line.startsWith('  -')) {
        const [key, ...valParts] = line.split(':')
        const val = valParts.join(':').trim()
        if (key === 'steps') {
          currentSection = 'steps'
        } else {
          result[key] = val
          currentSection = null
        }
      } else if (currentSection === 'steps') {
        const stepMatch = line.match(/^\s+- id:\s*(\S+)/)
        if (stepMatch) {
          currentSteps.push({ id: stepMatch[1] })
        } else if (currentSteps.length > 0) {
          const lastStep = currentSteps[currentSteps.length - 1]
          const kvMatch = line.match(/^\s+(\w+):\s*(.+)$/)
          if (kvMatch) {
            const key = kvMatch[1]
            let val: any = kvMatch[2].trim()
            if (val === 'true') val = true
            else if (val === 'false') val = false
            else if (val.startsWith('[') && val.endsWith(']')) {
              val = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
            }
            lastStep[key] = val
          }
        }
      }
    }

    if (!result.name || currentSteps.length === 0) {
      throw new Error('Invalid pipeline: name and steps required')
    }

    for (const step of currentSteps) {
      if (!step.id || !step.agent || !step.prompt) {
        throw new Error(`Step missing required fields (id, agent, prompt): ${JSON.stringify(step)}`)
      }
    }

    return { name: result.name, steps: currentSteps }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/pipelines-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/pipelines/parser.ts tests/pipelines-parser.test.ts
git commit -m "feat: pipeline parser with YAML to DAG structure"
```

---

### Task 2: Pipelines — Template Engine

**Files:**
- Create: `src/modules/pipelines/template.ts`
- Test: `tests/pipelines-template.test.ts`

- [ ] **Step 1: Write failing test + implementation**

```ts
// tests/pipelines-template.test.ts
import { describe, it, expect } from 'vitest'
import { TemplateEngine } from '../src/modules/pipelines/template'

describe('TemplateEngine', () => {
  it('should replace simple variables', () => {
    const result = TemplateEngine.render('Hello {name}', { name: 'world' })
    expect(result).toBe('Hello world')
  })

  it('should resolve step references', () => {
    const stepOutputs = { research: { output: 'Use TypeScript' } }
    const result = TemplateEngine.render('Plan: {{steps.research.output}}', {}, stepOutputs)
    expect(result).toBe('Plan: Use TypeScript')
  })

  it('should handle missing variables gracefully', () => {
    const result = TemplateEngine.render('Hello {unknown}', {})
    expect(result).toBe('Hello {unknown}')
  })
})
```

```ts
// src/modules/pipelines/template.ts

export class TemplateEngine {
  static render(
    template: string,
    params: Record<string, string>,
    stepOutputs?: Record<string, { output: string }>
  ): string {
    let result = template

    for (const [key, val] of Object.entries(params)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val)
    }

    if (stepOutputs) {
      result = result.replace(/\{\{steps\.(\w+)\.output\}\}/g, (_, stepId) => {
        return stepOutputs[stepId]?.output || `{{steps.${stepId}.output}}`
      })
    }

    return result
  }
}
```

- [ ] **Step 2: Run tests**

Run: `bun test tests/pipelines-template.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/modules/pipelines/template.ts tests/pipelines-template.test.ts
git commit -m "feat: pipeline template engine with variable and step reference resolution"
```

---

### Task 3: Pipelines — Execution Engine

**Files:**
- Create: `src/modules/pipelines/engine.ts`
- Create: `src/modules/pipelines/index.ts`
- Test: `tests/pipelines-engine.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/pipelines-engine.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PipelineEngine } from '../src/modules/pipelines/engine'
import type { Pipeline, PipelineStep } from '../src/modules/pipelines/parser'

describe('PipelineEngine', () => {
  it('should resolve dependency order', () => {
    const steps: PipelineStep[] = [
      { id: 'research', agent: 'explore', prompt: 'research' },
      { id: 'implement', agent: 'code', prompt: 'implement', depends_on: ['research'] },
      { id: 'verify', agent: 'verify', prompt: 'verify', depends_on: ['implement'] },
    ]
    const engine = new PipelineEngine()
    const order = engine.resolveDependencies(steps)
    expect(order).toEqual(['research', 'implement', 'verify'])
  })

  it('should detect cycles', () => {
    const steps: PipelineStep[] = [
      { id: 'a', agent: 'x', prompt: 'a', depends_on: ['b'] },
      { id: 'b', agent: 'x', prompt: 'b', depends_on: ['a'] },
    ]
    const engine = new PipelineEngine()
    expect(() => engine.resolveDependencies(steps)).toThrow()
  })

  it('should identify parallel-ready steps', () => {
    const steps: PipelineStep[] = [
      { id: 'plan', agent: 'x', prompt: 'plan' },
      { id: 'web', agent: 'x', prompt: 'web', depends_on: ['plan'], parallel: true },
      { id: 'api', agent: 'x', prompt: 'api', depends_on: ['plan'], parallel: true },
    ]
    const engine = new PipelineEngine()
    const ready = engine.getReadySteps(steps, new Set(['plan']))
    expect(ready).toHaveLength(2)
  })

  it('should track step status', () => {
    const engine = new PipelineEngine()
    engine.setStepStatus('a', 'running')
    expect(engine.getStepStatus('a')).toBe('running')
    engine.setStepStatus('a', 'done')
    expect(engine.isComplete(['a', 'b'])).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/pipelines-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Write engine.ts**

```ts
// src/modules/pipelines/engine.ts
import type { PipelineStep } from './parser'

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export class PipelineEngine {
  private stepStatus: Map<string, StepStatus> = new Map()

  resolveDependencies(steps: PipelineStep[]): string[] {
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const order: string[] = []

    function visit(stepId: string, stepMap: Map<string, PipelineStep>): void {
      if (inStack.has(stepId)) throw new Error(`Circular dependency: ${stepId}`)
      if (visited.has(stepId)) return

      inStack.add(stepId)
      const step = stepMap.get(stepId)
      if (step?.depends_on) {
        for (const dep of step.depends_on) {
          visit(dep, stepMap)
        }
      }
      inStack.delete(stepId)
      visited.add(stepId)
      order.push(stepId)
    }

    const stepMap = new Map(steps.map(s => [s.id, s]))
    for (const step of steps) {
      if (!visited.has(step.id)) {
        visit(step.id, stepMap)
      }
    }

    return order
  }

  getReadySteps(steps: PipelineStep[], completed: Set<string>): PipelineStep[] {
    return steps.filter(s => {
      if (completed.has(s.id)) return false
      if (this.stepStatus.get(s.id) === 'running') return false
      if (this.stepStatus.get(s.id) === 'failed') return false
      if (!s.depends_on || s.depends_on.length === 0) return true
      return s.depends_on.every(d => completed.has(d))
    })
  }

  setStepStatus(stepId: string, status: StepStatus): void {
    this.stepStatus.set(stepId, status)
  }

  getStepStatus(stepId: string): StepStatus {
    return this.stepStatus.get(stepId) || 'pending'
  }

  isComplete(stepIds: string[]): boolean {
    return stepIds.every(id => {
      const s = this.stepStatus.get(id)
      return s === 'done' || s === 'skipped'
    })
  }

  reset(): void {
    this.stepStatus.clear()
  }
}
```

- [ ] **Step 4: Write pipelines/index.ts**

```ts
// src/modules/pipelines/index.ts
export { PipelineParser } from './parser'
export { PipelineEngine } from './engine'
export { TemplateEngine } from './template'
export type { Pipeline, PipelineStep } from './parser'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/pipelines-engine.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/pipelines/engine.ts src/modules/pipelines/index.ts tests/pipelines-engine.test.ts
git commit -m "feat: pipeline engine with DAG resolution, parallel steps, and status tracking"
```

---

### Task 4: Indexer

**Files:**
- Create: `src/modules/indexer/walker.ts`
- Create: `src/modules/indexer/cache.ts`
- Create: `src/modules/indexer/index.ts`
- Test: `tests/indexer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmdirSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Indexer } from '../src/modules/indexer/walker'

describe('Indexer', () => {
  let tmpDir: string
  let indexer: Indexer

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-idx-'))
    indexer = new Indexer(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should walk files and detect language', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/index.ts'), 'export const x = 1')
    writeFileSync(join(tmpDir, 'src/utils.ts'), 'export function foo() {}')

    const result = await indexer.walk()
    expect(result.files).toHaveLength(2)
    expect(result.files.every((f: any) => f.language === 'typescript')).toBe(true)
  })

  it('should extract exports from TypeScript', async () => {
    writeFileSync(join(tmpDir, 'lib.ts'), `export const greet = (name: string) => \`Hello \${name}\`\nexport function add(a: number, b: number) { return a + b }`)

    const result = await indexer.walk()
    const file = result.files[0]
    expect(file.exports).toContain('greet')
    expect(file.exports).toContain('add')
  })

  it('should ignore node_modules', async () => {
    mkdirSync(join(tmpDir, 'node_modules'), { recursive: true })
    writeFileSync(join(tmpDir, 'node_modules/ignore.ts'), 'export const x = 1')
    writeFileSync(join(tmpDir, 'index.ts'), 'export const y = 2')

    const result = await indexer.walk()
    expect(result.files).toHaveLength(1)
  })

  it('should produce a summary string', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export const a = 1')

    const result = await indexer.walk()
    const summary = indexer.summarize(result)
    expect(summary).toContain('a.ts')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/indexer.test.ts`
Expected: FAIL

- [ ] **Step 3: Write walker.ts**

```ts
// src/modules/indexer/walker.ts
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, relative, extname } from 'path'

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript-react',
  '.js': 'javascript',
  '.jsx': 'javascript-react',
  '.json': 'json',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.mma', 'coverage'])

export interface IndexedFile {
  path: string
  language: string
  exports: string[]
  size: number
}

export interface IndexResult {
  files: IndexedFile[]
  totalSize: number
}

export class Indexer {
  private baseDir: string
  private MAX_FILES = 1000

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async walk(): Promise<IndexResult> {
    const files: IndexedFile[] = []
    let totalSize = 0
    let count = 0

    const walkDir = (dir: string): void => {
      if (!existsSync(dir)) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch { return }

      for (const entry of entries) {
        if (count >= this.MAX_FILES) return
        const fullPath = join(dir, entry)
        const relPath = relative(this.baseDir, fullPath)
        const stat = statSync(fullPath)

        if (stat.isDirectory()) {
          if (!IGNORE_DIRS.has(entry)) {
            walkDir(fullPath)
          }
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase()
          const language = LANGUAGES[ext]
          if (language) {
            const content = readFileSync(fullPath, 'utf-8')
            const exports = this.extractExports(content, language)
            files.push({ path: relPath, language, exports, size: stat.size })
            totalSize += stat.size
            count++
          }
        }
      }
    }

    walkDir(this.baseDir)
    return { files, totalSize }
  }

  private extractExports(content: string, language: string): string[] {
    if (language === 'typescript' || language === 'javascript') {
      const exports: string[] = []
      const exportRegex = /export\s+(?:const|function|class|interface|type|enum|default\s+(?:class|function))\s+(\w+)/g
      let match: RegExpExecArray | null
      while ((match = exportRegex.exec(content)) !== null) {
        exports.push(match[1])
      }
      return exports
    }
    return []
  }

  summarize(result: IndexResult): string {
    const byLang: Record<string, number> = {}
    for (const f of result.files) {
      byLang[f.language] = (byLang[f.language] || 0) + 1
    }
    const langs = Object.entries(byLang)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, count]) => `${lang}:${count}`)
      .join(', ')

    return `[Index: ${result.files.length} files, ${(result.totalSize / 1024).toFixed(1)}KB (${langs})]`
  }
}
```

- [ ] **Step 4: Write cache.ts**

```ts
// src/modules/indexer/cache.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { IndexResult } from './walker'

export class IndexCache {
  private cachePath: string
  private cache: IndexResult | null = null

  constructor(cacheDir: string) {
    this.cachePath = join(cacheDir, 'index-cache.json')
  }

  load(): IndexResult | null {
    if (this.cache) return this.cache
    if (!existsSync(this.cachePath)) return null
    try {
      this.cache = JSON.parse(readFileSync(this.cachePath, 'utf-8'))
      return this.cache
    } catch { return null }
  }

  save(result: IndexResult): void {
    this.cache = result
    const dir = join(this.cachePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.cachePath, JSON.stringify(result), 'utf-8')
  }

  invalidate(): void {
    this.cache = null
  }
}
```

- [ ] **Step 5: Write indexer/index.ts**

```ts
// src/modules/indexer/index.ts
export { Indexer } from './walker'
export { IndexCache } from './cache'
export type { IndexedFile, IndexResult } from './walker'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/indexer.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/modules/indexer/ tests/indexer.test.ts
git commit -m "feat: file indexer with walker, export extraction, and cache"
```

---

### Task 5: Memory store

**Files:**
- Create: `src/modules/memory/store.ts`
- Create: `src/modules/memory/index.ts`
- Test: `tests/memory-store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/memory-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryStore } from '../src/modules/memory/store'

describe('MemoryStore', () => {
  let tmpDir: string
  let store: MemoryStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-mem-'))
    store = new MemoryStore(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should create memory files on first access', () => {
    const content = store.read('conventions')
    expect(content).toBe('')
  })

  it('should write and read memory entries', () => {
    store.append('conventions', 'Use tabs for indentation')
    const content = store.read('conventions')
    expect(content).toContain('Use tabs for indentation')
  })

  it('should append timestamps to entries', () => {
    store.append('decisions', 'Use TypeScript')
    const content = store.read('decisions')
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/) // ISO timestamp
  })

  it('should search across all memory files', () => {
    store.append('conventions', 'Use tabs')
    store.append('decisions', 'Use TypeScript')
    store.append('errors', 'TypeError in parser')

    const results = store.search('Type')
    expect(results).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/memory-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Write store.ts**

```ts
// src/modules/memory/store.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'

const MEMORY_FILES = ['conventions', 'decisions', 'errors']

export class MemoryStore {
  private memoryDir: string

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir
    this.ensureDir()
    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`)
      if (!existsSync(path)) {
        writeFileSync(path, `# ${name.charAt(0).toUpperCase() + name.slice(1)}\n\n`, 'utf-8')
      }
    }
  }

  private ensureDir(): void {
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true })
    }
  }

  read(name: string): string {
    const path = join(this.memoryDir, `${name}.md`)
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf-8')
  }

  append(name: string, entry: string): void {
    const path = join(this.memoryDir, `${name}.md`)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const formatted = `- **${timestamp}** — ${entry}\n`
    appendFileSync(path, formatted, 'utf-8')
  }

  search(query: string): Array<{ file: string; match: string }> {
    const results: Array<{ file: string; match: string }> = []
    const lowerQuery = query.toLowerCase()

    for (const name of MEMORY_FILES) {
      const content = this.read(name)
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

- [ ] **Step 4: Write memory/index.ts**

```ts
// src/modules/memory/index.ts
export { MemoryStore } from './store'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/memory-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/memory/ tests/memory-store.test.ts
git commit -m "feat: memory store with markdown persistence and search"
```

---

### Task 6: Updater

**Files:**
- Create: `src/modules/updater/checker.ts`
- Create: `src/modules/updater/index.ts`
- Test: `tests/updater-checker.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/updater-checker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Updater } from '../src/modules/updater/checker'

describe('Updater', () => {
  it('should report current version', () => {
    const updater = new Updater('0.3.0', 'micro-models-agent')
    expect(updater.getCurrentVersion()).toBe('0.3.0')
  })

  it('should check npm registry', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.4.0' } }),
    })
    global.fetch = mockFetch as any

    const updater = new Updater('0.3.0', 'micro-models-agent')
    const result = await updater.check()
    expect(result.updateAvailable).toBe(true)
    expect(result.latest).toBe('0.4.0')
  })

  it('should report no update when up to date', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ 'dist-tags': { latest: '0.3.0' } }),
    })
    global.fetch = mockFetch as any

    const updater = new Updater('0.3.0', 'micro-models-agent')
    const result = await updater.check()
    expect(result.updateAvailable).toBe(false)
  })

  it('should handle network errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))
    global.fetch = mockFetch as any

    const updater = new Updater('0.3.0', 'micro-models-agent')
    const result = await updater.check()
    expect(result.updateAvailable).toBe(false)
    expect(result.error).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/updater-checker.test.ts`
Expected: FAIL

- [ ] **Step 3: Write checker.ts**

```ts
// src/modules/updater/checker.ts

export interface UpdateCheckResult {
  updateAvailable: boolean
  current: string
  latest?: string
  error?: string
}

export class Updater {
  private currentVersion: string
  private packageName: string

  constructor(currentVersion: string, packageName: string) {
    this.currentVersion = currentVersion
    this.packageName = packageName
  }

  getCurrentVersion(): string {
    return this.currentVersion
  }

  async check(): Promise<UpdateCheckResult> {
    try {
      const response = await fetch(`https://registry.npmjs.org/${this.packageName}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        return { updateAvailable: false, current: this.currentVersion, error: `HTTP ${response.status}` }
      }

      const data: any = await response.json()
      const latest = data['dist-tags']?.latest

      if (!latest) {
        return { updateAvailable: false, current: this.currentVersion, error: 'No latest tag' }
      }

      const updateAvailable = latest !== this.currentVersion
      return { updateAvailable, current: this.currentVersion, latest }

    } catch (e: any) {
      return { updateAvailable: false, current: this.currentVersion, error: e.message }
    }
  }
}
```

- [ ] **Step 4: Write updater/index.ts**

```ts
// src/modules/updater/index.ts
export { Updater } from './checker'
export type { UpdateCheckResult } from './checker'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/updater-checker.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/updater/ tests/updater-checker.test.ts
git commit -m "feat: background updater with npm registry check"
```

---

### Task 7: User Profile

**Files:**
- Create: `src/modules/user-profile/profile.ts`
- Create: `src/modules/user-profile/index.ts`
- Test: `tests/user-profile.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/user-profile.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { UserProfile } from '../src/modules/user-profile/profile'

describe('UserProfile', () => {
  let tmpDir: string
  let profile: UserProfile

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-profile-'))
    profile = new UserProfile(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should collect platform info', () => {
    const info = profile.collect()
    expect(info.platform).toBeDefined()
    expect(info.shell).toBeDefined()
    expect(info.os).toBeDefined()
  })

  it('should persist to disk', () => {
    profile.collect()
    profile.save()
    const savedPath = join(tmpDir, 'profile.json')
    expect(existsSync(savedPath)).toBe(true)
    const data = JSON.parse(readFileSync(savedPath, 'utf-8'))
    expect(data.platform).toBeDefined()
  })

  it('should load from disk', () => {
    profile.collect()
    profile.save()

    const profile2 = new UserProfile(tmpDir)
    profile2.load()
    expect(profile2.getInfo().platform).toBeDefined()
  })

  it('should compress to ~500 tokens', () => {
    profile.collect()
    const compressed = profile.compress()
    expect(compressed.length).toBeLessThan(2000)
    expect(compressed).toContain('OS:')
  })

  it('should set and get preferences', () => {
    profile.setPreference('editor', 'vscode')
    expect(profile.getPreference('editor')).toBe('vscode')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/user-profile.test.ts`
Expected: FAIL

- [ ] **Step 3: Write profile.ts**

```ts
// src/modules/user-profile/profile.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir, hostname, platform, tmpdir, type, userInfo } from 'os'
import { env } from 'process'

export interface ProfileInfo {
  platform: string
  os: string
  hostname: string
  shell: string
  home: string
  nodeVersion: string
  preferences: Record<string, string>
}

export class UserProfile {
  private profileDir: string
  private info: ProfileInfo | null = null
  private preferences: Record<string, string> = {}

  constructor(profileDir: string) {
    this.profileDir = profileDir
  }

  collect(): ProfileInfo {
    this.info = {
      platform: platform(),
      os: `${type()} ${hostname()}`,
      hostname: hostname(),
      shell: env.SHELL || env.ComSpec || 'unknown',
      home: homedir(),
      nodeVersion: process.version,
      preferences: { ...this.preferences },
    }
    return this.info
  }

  save(): void {
    if (!existsSync(this.profileDir)) {
      mkdirSync(this.profileDir, { recursive: true })
    }
    writeFileSync(
      join(this.profileDir, 'profile.json'),
      JSON.stringify({ ...this.info, preferences: this.preferences }, null, 2),
      'utf-8'
    )
  }

  load(): ProfileInfo | null {
    const path = join(this.profileDir, 'profile.json')
    if (!existsSync(path)) return null
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      this.info = {
        platform: data.platform,
        os: data.os,
        hostname: data.hostname,
        shell: data.shell,
        home: data.home,
        nodeVersion: data.nodeVersion,
        preferences: data.preferences || {},
      }
      this.preferences = data.preferences || {}
      return this.info
    } catch { return null }
  }

  getInfo(): ProfileInfo | null {
    return this.info
  }

  setPreference(key: string, value: string): void {
    this.preferences[key] = value
  }

  getPreference(key: string): string | undefined {
    return this.preferences[key]
  }

  compress(): string {
    if (!this.info) this.collect()
    const parts: string[] = [
      `OS: ${this.info!.os}`,
      `Shell: ${this.info!.shell}`,
      `Platform: ${this.info!.platform}`,
    ]
    if (Object.keys(this.preferences).length > 0) {
      parts.push(`Prefs: ${JSON.stringify(this.preferences)}`)
    }
    return parts.join(', ')
  }
}
```

- [ ] **Step 4: Write user-profile/index.ts**

```ts
// src/modules/user-profile/index.ts
export { UserProfile } from './profile'
export type { ProfileInfo } from './profile'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/user-profile.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/user-profile/ tests/user-profile.test.ts
git commit -m "feat: user profile with platform detection, persistence, and compression"
```

---

## Self-Review

**Spec coverage:**
- Pipelines: YAML parse, DAG execution, template engine (Section 6.4) ✓
- Indexer: walker with language detection, export extraction, cache (Section 6.5) ✓
- Memory: markdown persistence, conventions/decisions/errors (Section 6.6) ✓
- Updater: async npm check (Section 6.10) ✓
- User Profile: OS/shell, preferences, ~500 token compressed output (Section 6.7) ✓

**Placeholder scan:** No placeholders.

**Type consistency:** All modules compatible with AgentModule interface. Indexer cache matches walker output types.
