# Memory Quality Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent garbage, duplicates, and low-quality entries from polluting persistent memory (`conventions.md`, `decisions.md`, `errors.md`, `facts.md`), eliminating the self-reinforcing memory corruption loop described in the "Agent Memory Broke" article.

**Architecture:** New `MemoryValidator` class with deterministic rules (min length, min words, garbage pattern detection, duplicate detection). Integrated into `MemoryStore.append()` and `MemoryStore.appendRule()` as a write-time quality gate. Configurable strictness via `memory.validator` config. Rejected entries surface a warning to the agent instead of silently corrupting memory.

**Tech Stack:** TypeScript, bun:test

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/modules/memory/validator.ts` | **NEW** — `MemoryValidator` class: validates entries before write, detects garbage/duplicates/short entries |
| `src/modules/memory/store.ts` | **MODIFY** — integrate validator into `append()` and `appendRule()`, return validation result |
| `src/tools/remember.ts` | **MODIFY** — surface validation warnings to agent output |
| `src/config/types.ts` | **MODIFY** — add `MemoryValidatorConfig` to `AppConfig` |
| `src/config/defaults.ts` | **MODIFY** — add default validator config |
| `src/i18n/en.json` | **MODIFY** — add `memory.validator.*` keys |
| `src/i18n/ru.json` | **MODIFY** — add matching Russian keys |
| `AGENTS.md` | **MODIFY** — add Small Model Engineering Principles section |
| `tests/modules/memory/validator.test.ts` | **NEW** — unit tests for all validation rules |
| `tests/modules/memory/store-gate.test.ts` | **NEW** — integration tests: store rejects garbage, accepts valid |

---

## Task 1: MemoryValidator — Core Validation Logic

**Files:**
- Create: `src/modules/memory/validator.ts`
- Create: `tests/modules/memory/validator.test.ts`

### Step 1.1: Write failing tests

```typescript
// tests/modules/memory/validator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryValidator, type ValidationResult } from '../../../src/modules/memory/validator'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('MemoryValidator', () => {
  let tmpDir: string
  let validator: MemoryValidator

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-memval-'))
    validator = new MemoryValidator(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('garbage detection', () => {
    it('rejects single hyphen', () => {
      const result = validator.validate('conventions', '-')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('garbage')
    })

    it('rejects markdown heading as entry', () => {
      const result = validator.validate('conventions', '**Activity Summary (March 20, 2026)**')
      expect(result.accepted).toBe(false)
    })

    it('rejects checkbox fragment', () => {
      const result = validator.validate('decisions', '[x] I acknowledge the experience')
      expect(result.accepted).toBe(false)
    })

    it('rejects empty string', () => {
      const result = validator.validate('conventions', '')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('short')
    })

    it('rejects whitespace-only', () => {
      const result = validator.validate('conventions', '   \n  ')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('short')
    })
  })

  describe('length validation', () => {
    it('rejects entries under 15 chars', () => {
      const result = validator.validate('conventions', 'short')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('short')
    })

    it('rejects entries under 3 words', () => {
      const result = validator.validate('facts', 'user interaction')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('words')
    })

    it('accepts entries meeting both thresholds', () => {
      const result = validator.validate('conventions', 'Use TypeScript for all new modules in the project')
      expect(result.accepted).toBe(true)
    })
  })

  describe('duplicate detection', () => {
    it('rejects exact duplicate of existing entry', () => {
      writeFileSync(join(tmpDir, 'conventions.md'), '# Conventions\n\n- Use TypeScript for all new modules\n')
      const result = validator.validate('conventions', 'Use TypeScript for all new modules')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('duplicate')
    })

    it('rejects near-duplicate (Jaccard >= 0.8)', () => {
      writeFileSync(join(tmpDir, 'conventions.md'), '# Conventions\n\n- Use TypeScript for all new modules in the project\n')
      // Jaccard({use,typescript,new,modules,project}, {use,typescript,new,modules}) = 4/5 = 0.8
      const result = validator.validate('conventions', 'Use TypeScript for all new modules')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('similar')
    })

    it('accepts entries with Jaccard < 0.8', () => {
      writeFileSync(join(tmpDir, 'decisions.md'), '# Decisions\n\n- Chose Bun runtime for performance reasons\n')
      const result = validator.validate('decisions', 'Added ESLint with strict TypeScript rules')
      expect(result.accepted).toBe(true)
    })
  })

  describe('category-specific rules', () => {
    it('facts must have enough meaningful words (not just a label)', () => {
      const result = validator.validate('facts', 'TypeScript')
      expect(result.accepted).toBe(false)
    })

    it('errors must have >20 chars (meaningful description)', () => {
      const result = validator.validate('errors', 'timeout error')
      expect(result.accepted).toBe(false)
    })

    it('preferences bypass length check (key=value format)', () => {
      const result = validator.validate('preferences', 'color=blue')
      expect(result.accepted).toBe(true)
    })
  })

  describe('appendRule field validation', () => {
    it('rejects garbage pattern field even when wrapped in template', () => {
      const result = validator.validateRule('errors', '-', 'cause text here', 'solution text here')
      expect(result.accepted).toBe(false)
      expect(result.reason).toContain('pattern')
    })

    it('accepts valid appendRule fields', () => {
      const result = validator.validateRule('errors', 'timeout when connecting', 'database unavailable', 'retry with backoff')
      expect(result.accepted).toBe(true)
    })
  })

  describe('bilingual support', () => {
    it('accepts Russian entries meeting length thresholds', () => {
      const result = validator.validate('conventions', 'Использовать TypeScript для всех новых модулей')
      expect(result.accepted).toBe(true)
    })

    it('rejects short Russian entries', () => {
      const result = validator.validate('conventions', 'да')
      expect(result.accepted).toBe(false)
    })
  })
})
```

### Step 1.2: Run tests to verify they fail

Run: `bun test tests/modules/memory/validator.test.ts`
Expected: FAIL — module not found

### Step 1.3: Implement MemoryValidator

```typescript
// src/modules/memory/validator.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const GARBAGE_PATTERNS = [
  /^-$/,                           // single hyphen
  /^\[x\]\s/i,                     // checkbox fragment
  /^#+\s/,                         // markdown heading
  /^\*{1,2}[A-Z].*\*{1,2}$/,      // bold/italic heading like **Summary**
  /^[{}\[\]]+$/,                   // bare brackets
  /^\d+$/,                         // just a number
  /^[a-zа-яё]$/i,                  // single letter (en/ru)
]

// Stop words for similarity — only used for Jaccard, not for quality checks
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'and', 'or',
  'but', 'not', 'no', 'so', 'if', 'then', 'that', 'this', 'it', 'its',
  // Russian stop words
  'и', 'в', 'не', 'на', 'я', 'что', 'с', 'он', 'а', 'то', 'все', 'она',
  'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы',
  'по', 'от', 'мы', 'как', 'мне', 'это', 'уже',
])

export interface ValidationResult {
  accepted: boolean
  reason?: string
}

export class MemoryValidator {
  private memoryDir: string
  private minChars: number
  private minWords: number
  private similarityThreshold: number

  constructor(
    memoryDir: string,
    opts?: { minChars?: number; minWords?: number; similarityThreshold?: number }
  ) {
    this.memoryDir = memoryDir
    this.minChars = opts?.minChars ?? 15
    this.minWords = opts?.minWords ?? 3
    // Jaccard threshold — 0.8 means only very near-duplicates are caught
    this.similarityThreshold = opts?.similarityThreshold ?? 0.8
  }

  /** Validate a plain text entry (used by `remember` tool). */
  validate(category: string, entry: string): ValidationResult {
    const trimmed = entry.trim()

    // Preferences are key=value — different rules
    if (category === 'preferences') {
      if (!trimmed.includes('=')) {
        return { accepted: false, reason: 'preference must be key=value format' }
      }
      return { accepted: true }
    }

    return this.validateEntry(category, trimmed)
  }

  /** Validate individual fields of appendRule (used by `agent.ts`). */
  validateRule(category: string, pattern: string, cause: string, solution: string): ValidationResult {
    const fields = [
      { name: 'pattern', value: pattern },
      { name: 'cause', value: cause },
      { name: 'solution', value: solution },
    ]

    for (const field of fields) {
      const trimmed = field.value.trim()
      if (trimmed.length < 5) {
        return { accepted: false, reason: `${field.name}: too short (${trimmed.length} chars)` }
      }
      for (const p of GARBAGE_PATTERNS) {
        if (p.test(trimmed)) {
          return { accepted: false, reason: `${field.name}: garbage pattern ${p.source}` }
        }
      }
    }

    // Check full entry for duplicates
    const fullEntry = `**pattern:** ${pattern}\n  **cause:** ${cause}\n  **solution:** ${solution}`
    return this.validateEntry(category, fullEntry)
  }

  private validateEntry(category: string, trimmed: string): ValidationResult {
    // Garbage patterns
    for (const p of GARBAGE_PATTERNS) {
      if (p.test(trimmed)) {
        return { accepted: false, reason: `garbage: matches pattern ${p.source}` }
      }
    }

    // Length checks
    if (trimmed.length < this.minChars) {
      return { accepted: false, reason: `short: ${trimmed.length} chars < ${this.minChars} minimum` }
    }

    const words = trimmed.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    if (words.length < this.minWords) {
      return { accepted: false, reason: `words: ${words.length} words < ${this.minWords} minimum` }
    }

    // Duplicate / near-duplicate detection
    const existing = this.readExisting(category)
    const dupCheck = this.checkDuplicate(trimmed, existing)
    if (!dupCheck.ok) {
      return { accepted: false, reason: dupCheck.reason! }
    }

    return { accepted: true }
  }

  private readExisting(category: string): string[] {
    const path = join(this.memoryDir, `${category}.md`)
    if (!existsSync(path)) return []
    const content = readFileSync(path, 'utf-8')
    return content
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => {
        // Strip timestamp prefix: "- **2026-08-11 12:00:00** — "
        let stripped = l.replace(/^- \*\*[\d\-: ]+\*\*\s*—\s*/, '')
        // Strip structural labels from appendRule entries for meaningful comparison
        stripped = stripped.replace(/\*\*pattern:\*\*\s*/g, '')
        stripped = stripped.replace(/\s*\*\*cause:\*\*\s*/g, ' ')
        stripped = stripped.replace(/\s*\*\*solution:\*\*\s*/g, ' ')
        return stripped.trim()
      })
  }

  private checkDuplicate(entry: string, existing: string[]): { ok: boolean; reason?: string } {
    const entryNorm = entry.toLowerCase().trim()

    for (const ex of existing) {
      const exNorm = ex.toLowerCase().trim()

      // Exact match
      if (exNorm === entryNorm) {
        return { ok: false, reason: 'duplicate: matches existing entry exactly' }
      }
    }

    // Near-duplicate: Jaccard similarity on content words only (no stop words)
    const entryTokens = this.getContentTokens(entry)
    for (const ex of existing) {
      const exTokens = this.getContentTokens(ex)
      const jaccard = this.jaccardSimilarity(entryTokens, exTokens)
      if (jaccard >= this.similarityThreshold) {
        return { ok: false, reason: `similar: ${Math.round(jaccard * 100)}% Jaccard overlap with existing entry` }
      }
    }

    return { ok: true }
  }

  /** Content words only — no stop words, no structural labels. */
  private getContentTokens(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-zа-яё0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    )
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1
    if (a.size === 0 || b.size === 0) return 0
    let intersection = 0
    for (const w of a) {
      if (b.has(w)) intersection++
    }
    const union = a.size + b.size - intersection
    return union === 0 ? 0 : intersection / union
  }
}
```

### Step 1.4: Run tests to verify they pass

Run: `bun test tests/modules/memory/validator.test.ts`
Expected: PASS

### Step 1.5: Commit

```bash
git add src/modules/memory/validator.ts tests/modules/memory/validator.test.ts
git commit -m "feat(memory): add MemoryValidator with garbage/duplicate/length checks"
```

---

## Task 2: Integrate Validator into MemoryStore

**Files:**
- Modify: `src/modules/memory/store.ts`
- Create: `tests/modules/memory/store-gate.test.ts`

### Step 2.1: Write failing integration tests

```typescript
// tests/modules/memory/store-gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { MemoryStore } from '../../../src/modules/memory/store'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('MemoryStore write gate', () => {
  let tmpDir: string
  let store: MemoryStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-memstore-'))
    store = new MemoryStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('append returns rejected result for garbage entry', () => {
    const result = store.append('conventions', '-')
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('garbage')
  })

  it('append returns accepted result for valid entry', () => {
    const result = store.append('conventions', 'Use TypeScript for all new modules')
    expect(result.accepted).toBe(true)
  })

  it('garbage entry is NOT written to file', () => {
    store.append('conventions', '-')
    const content = readFileSync(join(tmpDir, 'conventions.md'), 'utf-8')
    expect(content).not.toContain('- **')
  })

  it('valid entry IS written to file', () => {
    store.append('conventions', 'Use TypeScript for all new modules in the project')
    const content = readFileSync(join(tmpDir, 'conventions.md'), 'utf-8')
    expect(content).toContain('TypeScript')
  })

  it('appendRule returns rejected for garbage pattern', () => {
    const result = store.appendRule('errors', '-', 'cause text here', 'solution text here')
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('pattern')
  })

  it('appendRule returns accepted for valid fields', () => {
    const result = store.appendRule('errors', 'timeout when connecting', 'database unavailable', 'retry with backoff')
    expect(result.accepted).toBe(true)
  })

  it('duplicate entry is rejected', () => {
    store.append('conventions', 'Always use Bun for runtime')
    const result = store.append('conventions', 'Always use Bun for runtime')
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('duplicate')
  })
})
```

### Step 2.2: Run tests to verify they fail

Run: `bun test tests/modules/memory/store-gate.test.ts`
Expected: FAIL — `append()` returns `void`, no `accepted` property

### Step 2.3: Modify MemoryStore to use validator

Update `src/modules/memory/store.ts`:

```typescript
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { MemorySearch } from './search'
import { MemoryValidator, type ValidationResult } from './validator'

const MEMORY_FILES = ['conventions', 'decisions', 'errors', 'facts']

export class MemoryStore {
  private memoryDir: string
  private validator: MemoryValidator

  constructor(memoryDir: string, validatorOpts?: { minChars?: number; minWords?: number }) {
    this.memoryDir = memoryDir
    this.ensureDir()
    this.validator = new MemoryValidator(memoryDir, validatorOpts)
    for (const name of MEMORY_FILES) {
      const path = join(this.memoryDir, `${name}.md`)
      if (!existsSync(path)) {
        writeFileSync(path, `# ${name.charAt(0).toUpperCase() + name.slice(1)}\n\n`, 'utf-8')
      }
    }
  }

  // ... existing ensureDir, read, search, prefs methods unchanged ...

  append(category: string, entry: string): ValidationResult {
    const result = this.validator.validate(category, entry)
    if (!result.accepted) return result

    const path = join(this.memoryDir, `${category}.md`)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const formatted = `- **${timestamp}** — ${entry}\n`
    appendFileSync(path, formatted, 'utf-8')
    return { accepted: true }
  }

  appendRule(category: string, pattern: string, cause: string, solution: string): ValidationResult {
    // Validate individual fields — catches garbage like "-" in pattern
    const result = this.validator.validateRule(category, pattern, cause, solution)
    if (!result.accepted) return result

    const entry = `**pattern:** ${pattern}\n  **cause:** ${cause}\n  **solution:** ${solution}`
    const path = join(this.memoryDir, `${category}.md`)
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const formatted = `- **${timestamp}** — ${entry}\n`
    appendFileSync(path, formatted, 'utf-8')
    return { accepted: true }
  }
}
```

### Step 2.4: Run tests to verify they pass

Run: `bun test tests/modules/memory/store-gate.test.ts`
Expected: PASS

### Step 2.5: Run all existing memory tests to verify no regressions

Run: `bun test tests/modules/memory/`
Expected: PASS (existing search test unaffected)

### Step 2.6: Commit

```bash
git add src/modules/memory/store.ts tests/modules/memory/store-gate.test.ts
git commit -m "feat(memory): integrate MemoryValidator into store write path"
```

---

## Task 3: Surface Validation Warnings in remember Tool

**Files:**
- Modify: `src/tools/remember.ts`
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`

### Step 3.1: Add i18n key for rejection

In `src/i18n/en.json`, add:
```json
"tool.remember.rejected": "Entry rejected: {reason}. Rephrase with a concrete, actionable description."
```

In `src/i18n/ru.json`, add:
```json
"tool.remember.rejected": "Запись отклонена: {reason}. Переформулируйте конкретно и по делу."
```

Note: the existing success key `tool.remember.entry` is kept as-is.

### Step 3.2: Update remember tool handler

```typescript
// src/tools/remember.ts — update the append call (line ~63)
const validatorCfg = ctx.config.memory?.validator
const store = new MemoryStore(memoryDir, {
  enabled: validatorCfg?.enabled,
  minChars: validatorCfg?.minChars,
  minWords: validatorCfg?.minWords,
})
const result = store.append(category, entry)
if (!result.accepted) {
  return {
    success: false,
    output: t('tool.remember.rejected', { reason: result.reason }),
  }
}
// Existing success path unchanged
return {
  success: true,
  output: t('tool.remember.entry', { category, entry }),
}
```

### Step 3.3: Run typecheck

Run: `tsc --noEmit`
Expected: PASS

### Step 3.4: Run tests

Run: `bun test tests/modules/memory/`
Expected: PASS

### Step 3.5: Commit

```bash
git add src/tools/remember.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat(memory): surface validation warnings in remember tool output"
```

---

## Task 4: Config Integration

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`

### Step 4.1: Add config type

In `src/config/types.ts`, add to `AppConfig`:
```typescript
memory?: {
  validator?: {
    enabled?: boolean
    minChars?: number
    minWords?: number
    similarityThreshold?: number
  }
}
```

### Step 4.2: Add defaults

In `src/config/defaults.ts`, add:
```typescript
memory: {
  validator: {
    enabled: true,
    minChars: 15,
    minWords: 3,
    similarityThreshold: 0.8,
  },
},
```

### Step 4.3: Wire config into MemoryModule and MemoryStore

In `src/modules/memory/store.ts`, update constructor to accept `enabled`:
```typescript
constructor(memoryDir: string, validatorOpts?: { enabled?: boolean; minChars?: number; minWords?: number }) {
  this.memoryDir = memoryDir
  this.ensureDir()
  this.validator = new MemoryValidator(memoryDir, {
    minChars: validatorOpts?.minChars,
    minWords: validatorOpts?.minWords,
  })
  this.validationEnabled = validatorOpts?.enabled ?? true
  // ... init files ...
}
```

In `append()` and `appendRule()`, skip validation when disabled:
```typescript
append(category: string, entry: string): ValidationResult {
  if (this.validationEnabled) {
    const result = this.validator.validate(category, entry)
    if (!result.accepted) return result
  }
  // ... write ...
}
```

In `src/modules/memory/module.ts`, pass config to store:
```typescript
constructor(memoryDir?: string, validatorOpts?: { enabled?: boolean; minChars?: number; minWords?: number }) {
  const dir = memoryDir || join(homedir(), '.mma', 'memory')
  this.store = new MemoryStore(dir, validatorOpts)
}
```

### Step 4.4: Run typecheck

Run: `tsc --noEmit`
Expected: PASS

### Step 4.5: Commit

```bash
git add src/config/types.ts src/config/defaults.ts src/modules/memory/module.ts
git commit -m "feat(memory): add configurable validator thresholds via AppConfig"
```

---

## Task 5: Update agent.ts appendRule Call

**Files:**
- Modify: `src/core/agent.ts` (line ~639)

### Step 5.1: Handle validation result + pass config

The `appendRule` call in `agent.ts:639` now returns `ValidationResult`. Pass config and log rejected entries:

```typescript
const memDir = join(baseDir, ".mma", "memory");
const validatorCfg = config.memory?.validator;
const memStore = new MemoryStore(memDir, {
  enabled: validatorCfg?.enabled,
  minChars: validatorCfg?.minChars,
  minWords: validatorCfg?.minWords,
});
const ruleResult = memStore.appendRule(
  "errors",
  `${consecutiveToolFailures} consecutive tool failures`,
  "Multiple tools failing suggests environment or configuration issue",
  "Check dependencies, verify file paths, try write_file directly instead of shell commands",
);
if (!ruleResult.accepted) {
  logger.debug(`Memory rule rejected: ${ruleResult.reason}`);
}
```

### Step 5.2: Run typecheck

Run: `tsc --noEmit`
Expected: PASS

### Step 5.3: Run full test suite

Run: `bun test`
Expected: PASS

### Step 5.4: Commit

```bash
git add src/core/agent.ts
git commit -m "fix(memory): handle validation result from appendRule in agent loop"
```

---

## Task 6: Document Small Model Engineering Principles in AGENTS.md

**Files:**
- Modify: `AGENTS.md`

### Step 6.1: Add principles section

Add after the "Key Design Rules" section in AGENTS.md:

```markdown
## Small Model Engineering Principles (9B and below)

These principles emerged from production experience with Qwen3.5-9B and are validated by
community research (Zenn/shimo4228, HuggingFace discussions, Turnstone issues). They govern
how MMA's agent loop handles small model limitations.

### Principle 1: Context is a finite resource
Every token in the context window competes with the actual task. Few-shot examples, verbose
instructions, and redundant history all consume capacity the model needs for reasoning.
- **MMA implementation:** Dynamic context budget (10% system, 15% reserve, 75% history),
  compaction at 75% fill, no few-shot in system prompt.

### Principle 2: Generation-time constraints consume capacity
Constrained decoding (JSON Schema, grammar forcing) guarantees structure but the model spends
its limited capacity satisfying the constraint instead of producing quality content. For 9B
models, this results in empty/label-only output.
- **MMA implementation:** Free generation + post-hoc JSON parsing + non-streaming fallback.
  No grammar/schema enforcement on LLM output.

### Principle 3: Control at save time, not generation time
Deterministic validation after generation is cheaper than trying to control generation itself.
The decision "is this output good enough?" is deterministic; the generation "produce perfect
output" is probabilistic.
- **MMA implementation:** Hallucination pipeline (confidence + factual + consistency checks),
  stuck detector, plan enforcement, final audit, memory quality gate.

### Principle 4: One task per call
A single LLM call that must both extract information AND format it correctly is too heavy for
a small model. Separating responsibilities across multiple calls lets each call dedicate full
capacity to a single task.
- **MMA implementation:** 6-layer state machine (INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR),
  each phase one LLM call with one responsibility. Two-stage pipelines where needed.

### Self-reinforcing memory corruption
Small models are more likely to produce garbage output. If that garbage enters persistent
memory (conventions, decisions, errors), it becomes input for future distillation, causing
progressive corruption. A write-time quality gate with deterministic rules (min length, min
words, garbage patterns, duplicate detection) prevents this loop.
- **MMA implementation:** MemoryValidator in `src/modules/memory/validator.ts`.
```

### Step 6.2: Run typecheck

Run: `tsc --noEmit`
Expected: PASS

### Step 6.3: Commit

```bash
git add AGENTS.md
git commit -m "docs: add small model engineering principles from 9B production research"
```

---

## Verification Checklist

After all tasks:

1. `bun test` — all tests pass
2. `tsc --noEmit` — no type errors
3. Manual test: run `bun run mma "remember that -"` — should get rejected warning
4. Manual test: run `bun run mma "remember convention: Use TypeScript for all new modules"` — should succeed
5. Manual test: duplicate entry — should be rejected with "duplicate" reason
6. Check `~/.mma/memory/conventions.md` — no garbage entries
7. AGENTS.md contains "Small Model Engineering Principles" section with all 4 principles + memory corruption note
