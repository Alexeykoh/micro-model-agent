# Memory Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent memory (preferences, facts, conventions, decisions, errors) that the agent can read/write across sessions.

**Architecture:** Extend `MemoryStore` with preferences.json support, add `facts` category, create `remember`/`recall` tools, wire as `MemoryModule` in bootstrap.

**Tech Stack:** TypeScript, fs module, existing `MemoryStore`/`MemorySearch` classes.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/modules/memory/store.ts` | Modify | Add preferences.json (get/set/delete/getAll), add `facts` to MEMORY_FILES |
| `src/modules/memory/search.ts` | Modify | Add `facts` to MEMORY_FILES, add preferences.json search |
| `src/modules/memory/module.ts` | Create | `MemoryModule` implementing `AgentModule` |
| `src/tools/remember.ts` | Create | `remember` tool |
| `src/tools/recall.ts` | Create | `recall` tool |
| `src/tools/index.ts` | Modify | Register remember + recall tools |
| `src/core/bootstrap.ts` | Modify | Create + register `MemoryModule` |
| `src/i18n/en.json` | Modify | Add memory tool strings |
| `src/i18n/ru.json` | Modify | Add memory tool strings |
| `tests/memory-module.test.ts` | Create | Tests for store extensions, tools, module |

---

### Task 1: Extend MemoryStore with preferences.json + facts category

**Files:**
- Modify: `src/modules/memory/store.ts:5` (MEMORY_FILES constant)
- Modify: `src/modules/memory/store.ts` (add preference methods)

- [ ] **Step 1: Update MEMORY_FILES to include facts**

```typescript
// src/modules/memory/store.ts:5
const MEMORY_FILES = ['conventions', 'decisions', 'errors', 'facts']
```

- [ ] **Step 2: Add preferences.json methods to MemoryStore**

Add these methods after the existing `search()` method:

```typescript
  private prefsPath(): string {
    return join(this.memoryDir, 'preferences.json')
  }

  getPreferences(): Record<string, string> {
    const path = this.prefsPath()
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return {} }
  }

  setPreference(key: string, value: string): void {
    const prefs = this.getPreferences()
    prefs[key] = value
    writeFileSync(this.prefsPath(), JSON.stringify(prefs, null, 2), 'utf-8')
  }

  deletePreference(key: string): boolean {
    const prefs = this.getPreferences()
    if (!(key in prefs)) return false
    delete prefs[key]
    writeFileSync(this.prefsPath(), JSON.stringify(prefs, null, 2), 'utf-8')
    return true
  }
```

- [ ] **Step 3: Update search.ts MEMORY_FILES**

```typescript
// src/modules/memory/search.ts:4
const MEMORY_FILES = ['conventions', 'decisions', 'errors', 'facts']
```

Also add preferences search to the `query` method — after the for-loop over MEMORY_FILES, add:

```typescript
    // Search preferences.json
    const prefsPath = join(this.memoryDir, 'preferences.json')
    if (existsSync(prefsPath)) {
      try {
        const prefs: Record<string, string> = JSON.parse(readFileSync(prefsPath, 'utf-8'))
        for (const [key, value] of Object.entries(prefs)) {
          const searchStr = `${key}=${value}`
          if (searchStr.toLowerCase().includes(lowerQuery)) {
            results.push({ file: 'preferences', match: `${key} = ${value}` })
          }
        }
      } catch { /* skip */ }
    }
```

- [ ] **Step 4: Run existing memory tests to verify no regressions**

```bash
bun test tests/memory-store.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/memory/store.ts src/modules/memory/search.ts
git commit -m "feat(memory): add preferences.json support and facts category"
```

---

### Task 2: Create remember and recall tools

**Files:**
- Create: `src/tools/remember.ts`
- Create: `src/tools/recall.ts`

- [ ] **Step 1: Create remember tool**

```typescript
// src/tools/remember.ts
import { homedir } from 'os'
import { join } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { MemoryStore } from '../modules/memory/store'

const CATEGORIES = ['preferences', 'conventions', 'decisions', 'errors', 'facts']

export const rememberTool: ToolDefinition = {
  name: 'remember',
  description: 'Remember information across sessions. Use for user preferences, facts, conventions, decisions, or errors.',
  tags: ['memory'],
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Memory category: preferences, conventions, decisions, errors, facts',
        enum: CATEGORIES,
      },
      key: {
        type: 'string',
        description: 'Key name (required for preferences, e.g. "color", "language")',
      },
      value: {
        type: 'string',
        description: 'Value to store (required for preferences)',
      },
      entry: {
        type: 'string',
        description: 'Text entry to append (for conventions, decisions, errors, facts)',
      },
    },
    required: ['category'],
  },
  handler: async (_ctx, args) => {
    const category = String(args.category || '')
    if (!CATEGORIES.includes(category)) {
      return { success: false, output: t('tool.invalid_params') }
    }

    const memoryDir = join(homedir(), '.mma', 'memory')
    const store = new MemoryStore(memoryDir)

    if (category === 'preferences') {
      const key = String(args.key || '')
      const value = String(args.value || '')
      if (!key) {
        return { success: false, output: t('tool.remember.key_required') }
      }
      store.setPreference(key, value)
      return {
        success: true,
        output: t('tool.remember.preference', { key, value }),
      }
    }

    const entry = String(args.entry || '')
    if (!entry) {
      return { success: false, output: t('tool.remember.entry_required') }
    }
    store.append(category, entry)
    return {
      success: true,
      output: t('tool.remember.entry', { category, entry }),
    }
  },
}
```

- [ ] **Step 2: Create recall tool**

```typescript
// src/tools/recall.ts
import { homedir } from 'os'
import { join } from 'path'
import { t } from '../i18n/index'
import type { ToolDefinition } from './types'
import { MemoryStore } from '../modules/memory/store'

const CATEGORIES = ['preferences', 'conventions', 'decisions', 'errors', 'facts']

export const recallTool: ToolDefinition = {
  name: 'recall',
  description: 'Recall stored information from memory. Search across preferences, facts, conventions, decisions, errors.',
  tags: ['memory'],
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (full-text search across all memory)',
      },
      category: {
        type: 'string',
        description: 'Limit to specific category: preferences, conventions, decisions, errors, facts',
        enum: CATEGORIES,
      },
    },
  },
  handler: async (_ctx, args) => {
    const query = args.query ? String(args.query) : ''
    const category = args.category ? String(args.category) : ''
    const memoryDir = join(homedir(), '.mma', 'memory')
    const store = new MemoryStore(memoryDir)

    // No query, no category → show everything
    if (!query && !category) {
      return { success: true, output: formatAll(store) }
    }

    // Category only → show that category
    if (!query && category) {
      return { success: true, output: formatCategory(store, category) }
    }

    // Query with optional category → search
    if (category) {
      const results = searchCategory(store, category, query)
      if (results.length === 0) {
        return { success: true, output: t('tool.recall.empty', { query }) }
      }
      return { success: true, output: t('tool.recall.search_results', { category, results: results.join('\n') }) }
    }

    // Query across all
    const results = store.search(query)
    if (results.length === 0) {
      return { success: true, output: t('tool.recall.empty', { query }) }
    }
    const formatted = results.map(r => `[${r.file}] ${r.match}`).join('\n')
    return { success: true, output: t('tool.recall.search_results', { category: 'all', results: formatted }) }
  },
}

function formatAll(store: MemoryStore): string {
  const parts: string[] = []

  const prefs = store.getPreferences()
  if (Object.keys(prefs).length > 0) {
    parts.push('Preferences:')
    for (const [k, v] of Object.entries(prefs)) {
      parts.push(`  ${k} = ${v}`)
    }
  }

  for (const cat of ['facts', 'conventions', 'decisions', 'errors']) {
    const content = store.read(cat)
    const entries = content.split('\n').filter(l => l.startsWith('- '))
    if (entries.length > 0) {
      parts.push(`\n${cat.charAt(0).toUpperCase() + cat.slice(1)} (last 5):`)
      for (const e of entries.slice(-5)) {
        parts.push(`  ${e}`)
      }
    }
  }

  return parts.length > 0 ? parts.join('\n') : t('tool.recall.no_memory')
}

function formatCategory(store: MemoryStore, category: string): string {
  if (category === 'preferences') {
    const prefs = store.getPreferences()
    if (Object.keys(prefs).length === 0) return t('tool.recall.no_memory')
    const lines = ['Preferences:']
    for (const [k, v] of Object.entries(prefs)) {
      lines.push(`  ${k} = ${v}`)
    }
    return lines.join('\n')
  }

  const content = store.read(category)
  const entries = content.split('\n').filter(l => l.startsWith('- '))
  if (entries.length === 0) return t('tool.recall.no_memory')
  return `${category.charAt(0).toUpperCase() + category.slice(1)} (${entries.length} entries):\n${entries.join('\n')}`
}

function searchCategory(store: MemoryStore, category: string, query: string): string[] {
  if (category === 'preferences') {
    const prefs = store.getPreferences()
    const lower = query.toLowerCase()
    return Object.entries(prefs)
      .filter(([k, v]) => k.toLowerCase().includes(lower) || v.toLowerCase().includes(lower))
      .map(([k, v]) => `  ${k} = ${v}`)
  }

  const content = store.read(category)
  const lower = query.toLowerCase()
  return content.split('\n')
    .filter(l => l.startsWith('- ') && l.toLowerCase().includes(lower))
    .map(l => `  ${l}`)
}
```

- [ ] **Step 3: Run type check**

```bash
tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/remember.ts src/tools/recall.ts
git commit -m "feat(memory): add remember and recall tools"
```

---

### Task 3: Register tools in index.ts

**Files:**
- Modify: `src/tools/index.ts:1-67`

- [ ] **Step 1: Add imports and registration**

Add imports at the top (after line 29):

```typescript
import { rememberTool } from './remember'
import { recallTool } from './recall'
```

Add to the `tools` array in `registerAllTools` (after `searchHistoryTool`):

```typescript
    rememberTool, recallTool,
```

Add to the exports (after `searchHistoryTool` in the export block):

```typescript
  rememberTool, recallTool,
```

- [ ] **Step 2: Run type check**

```bash
tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat(memory): register remember/recall tools"
```

---

### Task 4: Create MemoryModule

**Files:**
- Create: `src/modules/memory/module.ts`

- [ ] **Step 1: Create the module**

```typescript
// src/modules/memory/module.ts
import { homedir } from 'os'
import { join } from 'path'
import type { AgentModule, AgentPlugin } from '../types'
import type { PromptBlock } from '../../core/types'
import type { ToolDefinition } from '../../tools/types'
import { MemoryStore } from './store'
import { rememberTool } from '../../tools/remember'
import { recallTool } from '../../tools/recall'

export class MemoryModule implements AgentModule {
  name = 'memory'
  private store: MemoryStore

  constructor(memoryDir?: string) {
    const dir = memoryDir || join(homedir(), '.mma', 'memory')
    this.store = new MemoryStore(dir)
  }

  getSystemPromptBlock(): PromptBlock | null {
    const prefs = this.store.getPreferences()
    if (Object.keys(prefs).length === 0) return null

    const prefStr = Object.entries(prefs)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')

    return {
      content: `User preferences: ${prefStr}`,
      priority: 'medium',
      essential: false,
      estimatedTokens: Math.ceil(prefStr.length / 4) + 10,
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [rememberTool, recallTool]
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'memory',
      isBuiltin: true,
      onBuildPrompt: () => {
        const prefs = this.store.getPreferences()
        if (Object.keys(prefs).length === 0) return null
        const prefStr = Object.entries(prefs)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
        return `User preferences: ${prefStr}`
      },
    }
  }

  getStore(): MemoryStore {
    return this.store
  }
}
```

- [ ] **Step 2: Run type check**

```bash
tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/modules/memory/module.ts
git commit -m "feat(memory): create MemoryModule with AgentModule interface"
```

---

### Task 5: Wire MemoryModule into bootstrap

**Files:**
- Modify: `src/core/bootstrap.ts:29-30` (add import)
- Modify: `src/core/bootstrap.ts:290-303` (register module)

- [ ] **Step 1: Add import**

After the existing memory import (line 2-3 area, near other module imports), add:

```typescript
import { MemoryModule } from "../modules/memory/module";
```

- [ ] **Step 2: Register the module**

After the `MCPModule` registration (around line 303), add:

```typescript
  const memoryModule = new MemoryModule(join(dir, 'memory'));
  moduleRegistry.register(memoryModule);
```

- [ ] **Step 3: Run type check**

```bash
tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/bootstrap.ts
git commit -m "feat(memory): register MemoryModule in bootstrap"
```

---

### Task 6: Add i18n strings

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`

- [ ] **Step 1: Add English strings**

Add before the closing `}` in `en.json`:

```json
  "tool.friendly.remember": "Remember",
  "tool.friendly.recall": "Recall",
  "tool.remember.preference": "Remembered: {key} = {value}",
  "tool.remember.entry": "Remembered: {category} — \"{entry}\"",
  "tool.remember.key_required": "Key is required for preferences",
  "tool.remember.entry_required": "Entry text is required",
  "tool.recall.empty": "Nothing found for \"{query}\"",
  "tool.recall.no_memory": "Memory is empty",
  "tool.recall.search_results": "{category} results:\n{results}"
```

- [ ] **Step 2: Add Russian strings**

Add before the closing `}` in `ru.json`:

```json
  "tool.friendly.remember": "Запомнить",
  "tool.friendly.recall": "Вспомнить",
  "tool.remember.preference": "Запомнено: {key} = {value}",
  "tool.remember.entry": "Запомнено: {category} — \"{entry}\"",
  "tool.remember.key_required": "Для preferences требуется ключ (key)",
  "tool.remember.entry_required": "Требуется текст записи",
  "tool.recall.empty": "Ничего не найдено по \"{query}\"",
  "tool.recall.no_memory": "Память пуста",
  "tool.recall.search_results": "Результаты {category}:\n{results}"
```

- [ ] **Step 3: Run type check**

```bash
tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/i18n/en.json src/i18n/ru.json
git commit -m "feat(memory): add i18n strings for remember/recall tools"
```

---

### Task 7: Write tests

**Files:**
- Create: `tests/memory-module.test.ts`

- [ ] **Step 1: Create tests**

```typescript
// tests/memory-module.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryStore } from '../src/modules/memory/store'
import { MemoryModule } from '../src/modules/memory/module'

describe('MemoryStore extensions', () => {
  let dir: string
  let store: MemoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-test-'))
    store = new MemoryStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should include facts in MEMORY_FILES', () => {
    expect(existsSync(join(dir, 'facts.md'))).toBe(true)
  })

  it('should set and get preferences', () => {
    store.setPreference('color', 'green')
    expect(store.getPreferences()).toEqual({ color: 'green' })
  })

  it('should overwrite preference', () => {
    store.setPreference('color', 'green')
    store.setPreference('color', 'blue')
    expect(store.getPreferences()).toEqual({ color: 'blue' })
  })

  it('should delete preference', () => {
    store.setPreference('color', 'green')
    const deleted = store.deletePreference('color')
    expect(deleted).toBe(true)
    expect(store.getPreferences()).toEqual({})
  })

  it('should return false when deleting non-existent preference', () => {
    const deleted = store.deletePreference('nonexistent')
    expect(deleted).toBe(false)
  })

  it('should append to facts', () => {
    store.append('facts', 'User prefers dark theme')
    const content = store.read('facts')
    expect(content).toContain('User prefers dark theme')
  })

  it('should search preferences', () => {
    store.setPreference('color', 'green')
    const results = store.search('green')
    expect(results.some(r => r.file === 'preferences' && r.match.includes('color'))).toBe(true)
  })

  it('should search facts', () => {
    store.append('facts', 'User works on MMA project')
    const results = store.search('MMA')
    expect(results.some(r => r.file === 'facts')).toBe(true)
  })
})

describe('MemoryModule', () => {
  let dir: string
  let mod: MemoryModule

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-module-test-'))
    mod = new MemoryModule(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('should return null prompt block when no preferences', () => {
    expect(mod.getSystemPromptBlock()).toBeNull()
  })

  it('should return prompt block with preferences', () => {
    mod.getStore().setPreference('color', 'green')
    const block = mod.getSystemPromptBlock()
    expect(block).not.toBeNull()
    expect(block!.content).toContain('color=green')
  })

  it('should provide remember and recall tools', () => {
    const tools = mod.getToolDefinitions()
    expect(tools.map(t => t.name)).toContain('remember')
    expect(tools.map(t => t.name)).toContain('recall')
  })

  it('should have plugin with onBuildPrompt', () => {
    const plugin = mod.getPlugin()
    expect(plugin.name).toBe('memory')
    expect(plugin.onBuildPrompt).toBeDefined()
  })

  it('plugin onBuildPrompt returns null when no preferences', () => {
    const plugin = mod.getPlugin()
    expect(plugin.onBuildPrompt!()).toBeNull()
  })

  it('plugin onBuildPrompt returns preferences string', () => {
    mod.getStore().setPreference('lang', 'ru')
    const plugin = mod.getPlugin()
    expect(plugin.onBuildPrompt!()).toContain('lang=ru')
  })
})
```

- [ ] **Step 2: Run tests**

```bash
bun test tests/memory-module.test.ts
```

Expected: PASS

- [ ] **Step 3: Run all tests to verify no regressions**

```bash
bun test
```

Expected: PASS

- [ ] **Step 4: Run type check**

```bash
tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/memory-module.test.ts
git commit -m "test(memory): add tests for MemoryStore extensions and MemoryModule"
```

---

### Task 8: Manual verification

- [ ] **Step 1: Build the project**

```bash
bun run build
```

Expected: PASS

- [ ] **Step 2: Test remember flow**

```bash
bun run mma "запомни что я люблю зелёный цвет" --no-agents-md --exit-on-complete -d _testing/memory
```

Expected: Agent calls `remember` tool, response confirms storage.

- [ ] **Step 3: Test recall flow**

```bash
bun run mma "какой цвет я люблю?" --no-agents-md --exit-on-complete -d _testing/memory
```

Expected: Agent calls `recall` tool, responds "зелёный".

- [ ] **Step 4: Clean up test directory**

```bash
Remove-Item -Recurse -Force _testing/memory
```
