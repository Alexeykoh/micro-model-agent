# Plan 6: Context + Hallucination — Context Manager, Session History, Hallucination Detection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build context management (dynamic budget calculation, sliding window compaction, session persistence) and hallucination detection (factual path checking, consistency verification, confidence heuristics).

**Architecture:** ContextManager calculates budget from `contextWindow`, tracks messages, triggers compaction at 75% history budget or every 15 iterations. Compaction keeps last 6 turns full, extracts facts/decisions/errors from older turns without a second LLM call. SessionHistory writes every message to JSONL. HallucinationDetector runs pre-output with 3 checks: factual (cross-reference paths), consistency (track sets), confidence (short/repetitive/uncertain).

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure

```
src/modules/context/
├── manager.ts       — ContextManager: budget calc, compaction, message buffer
├── history.ts       — SessionHistory: JSONL append, rotation, search_history
└── index.ts
src/modules/hallucination/
├── detector.ts      — HallucinationDetector: runs all checks pipeline
├── factual.ts       — FactualCheck: known paths vs mentioned paths
├── consistency.ts   — ConsistencyCheck: track created/deleted/decisions set
├── confidence.ts    — ConfidenceCheck: short/repetitive/uncertain markers
└── index.ts
```

Tests:
```
tests/
├── context-manager.test.ts
├── session-history.test.ts
├── hallucination-detector.test.ts
├── hallucination-factual.test.ts
├── hallucination-consistency.test.ts
└── hallucination-confidence.test.ts
```

---

### Task 1: Context Manager — budget and compaction

**Files:**
- Create: `src/modules/context/manager.ts`
- Create: `src/modules/context/index.ts`
- Test: `tests/context-manager.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/context-manager.test.ts
import { describe, it, expect } from 'vitest'
import { ContextManager } from '../src/modules/context/manager'

describe('ContextManager', () => {
  it('should calculate budget from context window', () => {
    const cm = new ContextManager(32768)
    const budget = cm.getBudget()
    expect(budget.systemPrompt).toBe(8192)   // 25%
    expect(budget.responseReserve).toBe(4096) // ~12.5%
    expect(budget.history).toBe(20480)        // ~62.5%
  })

  it('should add messages', () => {
    const cm = new ContextManager(32768)
    cm.addMessage({ role: 'user', content: 'hello' })
    expect(cm.getMessageCount()).toBe(1)
  })

  it('should detect compaction needed when history > 75%', () => {
    const cm = new ContextManager(100)
    // Fill history beyond 75% of 63 tokens ≈ 47 tokens
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: 'user', content: 'x'.repeat(10) })
    }
    expect(cm.needsCompaction()).toBe(true)
  })

  it('should compact old turns, keeping last 6', () => {
    const cm = new ContextManager(1000)
    for (let i = 0; i < 10; i++) {
      cm.addMessage({ role: 'user', content: `message ${i}` })
      cm.addMessage({ role: 'assistant', content: `response ${i}` })
    }
    cm.compact()
    const history = cm.getActiveHistory()
    // Should have compacted block + last 6 turns
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].role).toBe('system')
  })

  it('should not compact before threshold', () => {
    const cm = new ContextManager(100000)
    for (let i = 0; i < 3; i++) {
      cm.addMessage({ role: 'user', content: 'short' })
    }
    expect(cm.needsCompaction()).toBe(false)
  })

  it('should keep system prompt budget fixed', () => {
    const cm = new ContextManager(32768)
    expect(cm.getBudget().systemPrompt).toBe(8192)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/context-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Write manager.ts**

```ts
// src/modules/context/manager.ts

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export interface ContextBudget {
  systemPrompt: number
  responseReserve: number
  history: number
}

const COMPACTION_INTERVAL = 15
const KEEP_LAST_N = 6

export class ContextManager {
  private contextWindow: number
  private messages: Message[] = []
  private compactedBlock: string | null = null
  private iterationsSinceCompaction = 0
  private budget: ContextBudget

  constructor(contextWindow: number) {
    this.contextWindow = contextWindow
    this.budget = this.calculateBudget(contextWindow)
  }

  private calculateBudget(window: number): ContextBudget {
    return {
      systemPrompt: Math.floor(window * 0.25),
      responseReserve: Math.floor(window * 0.125),
      history: Math.floor(window * 0.625),
    }
  }

  getBudget(): ContextBudget {
    return { ...this.budget }
  }

  addMessage(msg: Message): void {
    this.messages.push(msg)
    this.iterationsSinceCompaction++
  }

  getMessageCount(): number {
    return this.messages.length
  }

  needsCompaction(): boolean {
    if (this.iterationsSinceCompaction >= COMPACTION_INTERVAL) return true
    const totalTokens = this.messages.reduce((sum, m) => sum + m.content.length / 2, 0)
    return totalTokens > this.budget.history * 0.75
  }

  compact(): void {
    if (this.messages.length <= KEEP_LAST_N * 2) return

    const cutoff = this.messages.length - KEEP_LAST_N * 2
    const oldTurns = this.messages.slice(0, cutoff)
    const recentTurns = this.messages.slice(cutoff)

    const facts: string[] = []
    const decisions: string[] = []
    const errors: string[] = []

    for (const msg of oldTurns) {
      if (msg.content.includes('[fact]') || msg.role === 'tool') {
        facts.push(msg.content.slice(0, 200))
      }
      if (msg.content.includes('decided') || msg.content.includes('decision:')) {
        decisions.push(msg.content.slice(0, 200))
      }
      if (msg.content.includes('Error:') || msg.content.includes('failed')) {
        errors.push(msg.content.slice(0, 300))
      }
    }

    const compactedParts: string[] = []
    if (facts.length > 0) compactedParts.push(`[Facts: ${facts.slice(-10).join('; ')}]`)
    if (decisions.length > 0) compactedParts.push(`[Decisions: ${decisions.slice(-5).join('; ')}]`)
    if (errors.length > 0) compactedParts.push(`[Errors: ${errors.slice(-3).join('; ')}]`)

    if (compactedParts.length > 0 || oldTurns.length > 0) {
      this.compactedBlock = `[Compressed: ${oldTurns.length} turns, ${facts.length} facts] ` + compactedParts.join(' ')
    }

    this.messages = [
      { role: 'system', content: this.compactedBlock || '' },
      ...recentTurns,
    ]
    this.iterationsSinceCompaction = 0
  }

  getActiveHistory(): Message[] {
    return [...this.messages]
  }
}
```

- [ ] **Step 4: Write context/index.ts**

```ts
// src/modules/context/index.ts
export { ContextManager } from './manager'
export type { Message, ContextBudget } from './manager'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/context-manager.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/context/manager.ts src/modules/context/index.ts tests/context-manager.test.ts
git commit -m "feat: context manager with budget calculation and compaction"
```

---

### Task 2: Session History

**Files:**
- Create: `src/modules/context/history.ts`
- Test: `tests/session-history.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/session-history.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionHistory } from '../src/modules/context/history'

describe('SessionHistory', () => {
  let tmpDir: string
  let history: SessionHistory

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-session-'))
    history = new SessionHistory(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should create session file on first append', async () => {
    await history.append('user', { content: 'hello' })
    const files = history.getSessionFiles()
    expect(files.length).toBeGreaterThan(0)
  })

  it('should append JSONL entries', async () => {
    await history.append('user', { content: 'hi' })
    await history.append('assistant', { content: 'hello' })

    const filePath = history.getSessionFiles()[0]
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('should search entries', async () => {
    await history.append('user', { content: 'implement OAuth' })
    await history.append('assistant', { content: 'I will create the routes' })

    const results = await history.search('OAuth')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toContain('OAuth')
  })

  it('should handle empty search', async () => {
    const results = await history.search('nonexistent')
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/session-history.test.ts`
Expected: FAIL

- [ ] **Step 3: Write history.ts**

```ts
// src/modules/context/history.ts
import { appendFileSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export class SessionHistory {
  private sessionDir: string
  private sessionId: string
  private filePath: string

  constructor(sessionDir: string, sessionId?: string) {
    this.sessionDir = sessionDir
    this.sessionId = sessionId || new Date().toISOString().replace(/[:.]/g, '-')
    this.filePath = join(this.sessionDir, `${this.sessionId}.jsonl`)

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true })
    }
  }

  async append(type: string, data: unknown): Promise<void> {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      data,
    })
    appendFileSync(this.filePath, entry + '\n', 'utf-8')
  }

  getSessionFiles(): string[] {
    if (!existsSync(this.sessionDir)) return []
    return readdirSync(this.sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(this.sessionDir, f))
  }

  async search(query: string, maxResults = 10): Promise<string[]> {
    const files = this.getSessionFiles()
    const results: string[] = []
    const lowerQuery = query.toLowerCase()

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      for (const line of lines) {
        if (line.toLowerCase().includes(lowerQuery)) {
          results.push(line)
          if (results.length >= maxResults) break
        }
      }
      if (results.length >= maxResults) break
    }

    return results
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/session-history.test.ts`
Expected: PASS

- [ ] **Step 5: Update context/index.ts**

```ts
// src/modules/context/index.ts
export { ContextManager } from './manager'
export { SessionHistory } from './history'
export type { Message, ContextBudget } from './manager'
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/context/history.ts src/modules/context/index.ts tests/session-history.test.ts
git commit -m "feat: session history with JSONL persistence and search"
```

---

### Task 3: Hallucination — factual check, consistency check, confidence check

**Files:**
- Create: `src/modules/hallucination/factual.ts`
- Create: `src/modules/hallucination/consistency.ts`
- Create: `src/modules/hallucination/confidence.ts`
- Create: `src/modules/hallucination/detector.ts`
- Create: `src/modules/hallucination/index.ts`
- Test: `tests/hallucination-factual.test.ts`
- Test: `tests/hallucination-consistency.test.ts`
- Test: `tests/hallucination-confidence.test.ts`
- Test: `tests/hallucination-detector.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/hallucination-factual.test.ts
import { describe, it, expect } from 'vitest'
import { FactualCheck } from '../src/modules/hallucination/factual'

describe('FactualCheck', () => {
  it('should pass when no paths mentioned', () => {
    const check = new FactualCheck()
    const result = check.validate('This is a response about the architecture')
    expect(result.status).toBe('pass')
  })

  it('should pass when mentioned path was read', () => {
    const check = new FactualCheck()
    check.trackReadPath('src/index.ts')
    const result = check.validate('I updated src/index.ts')
    expect(result.status).toBe('pass')
  })

  it('should warn when unknown path mentioned', () => {
    const check = new FactualCheck()
    const result = check.validate('I created src/new-file.ts')
    expect(result.status).toBe('warn')
    expect(result.reason).toContain('src/new-file.ts')
  })

  it('should track multiple paths', () => {
    const check = new FactualCheck()
    check.trackReadPath('a.ts')
    check.trackReadPath('b.ts')
    const result = check.validate('Check a.ts and b.ts')
    expect(result.status).toBe('pass')
  })
})
```

```ts
// tests/hallucination-consistency.test.ts
import { describe, it, expect } from 'vitest'
import { ConsistencyCheck } from '../src/modules/hallucination/consistency'

describe('ConsistencyCheck', () => {
  it('should pass initially', () => {
    const check = new ConsistencyCheck()
    const result = check.validate('some text')
    expect(result.status).toBe('pass')
  })

  it('should warn on decision reversal', () => {
    const check = new ConsistencyCheck()
    check.trackDecision('use express', 'src/index.ts')
    const result = check.validate('I decided to use fastify instead of express')
    expect(result.status).toBe('warn')
  })

  it('should track created files', () => {
    const check = new ConsistencyCheck()
    check.trackCreatedFile('a.ts')
    expect(check.getCreatedFiles()).toContain('a.ts')
  })
})
```

```ts
// tests/hallucination-confidence.test.ts
import { describe, it, expect } from 'vitest'
import { ConfidenceCheck } from '../src/modules/hallucination/confidence'

describe('ConfidenceCheck', () => {
  it('should retry on empty response', () => {
    const check = new ConfidenceCheck()
    const result = check.validate('')
    expect(result.status).toBe('retry')
  })

  it('should retry on short response', () => {
    const check = new ConfidenceCheck()
    const result = check.validate('OK')
    expect(result.status).toBe('retry')
  })

  it('should retry on repetitive response', () => {
    const check = new ConfidenceCheck()
    check.setPreviousResponse('I think we should use TypeScript')
    const result = check.validate('I think we should use TypeScript and I think we should use TypeScript')
    expect(result.status).toBe('retry')
  })

  it('should warn on uncertainty markers', () => {
    const check = new ConfidenceCheck()
    const result = check.validate('I think maybe we should probably use this approach')
    expect(result.status).toBe('warn')
  })

  it('should pass on normal response', () => {
    const check = new ConfidenceCheck()
    const result = check.validate('We should use the standard library for this task.')
    expect(result.status).toBe('pass')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/hallucination-factual.test.ts tests/hallucination-consistency.test.ts tests/hallucination-confidence.test.ts`
Expected: FAIL

- [ ] **Step 3: Write factual.ts**

```ts
// src/modules/hallucination/factual.ts

export interface HallucinationCheckResult {
  status: 'pass' | 'warn' | 'retry' | 'block'
  reason?: string
}

export class FactualCheck {
  private knownPaths: Set<string> = new Set()
  private createdPaths: Set<string> = new Set()

  trackReadPath(path: string): void {
    this.knownPaths.add(path)
  }

  trackCreatedPath(path: string): void {
    this.knownPaths.add(path)
    this.createdPaths.add(path)
  }

  validate(response: string): HallucinationCheckResult {
    const pathRegex = /[\w\-./]+\.\w+/g
    const mentionedPaths = response.match(pathRegex) || []

    const unknownPaths = mentionedPaths.filter(p => {
      if (this.knownPaths.has(p)) return false
      if (p.startsWith('http')) return false
      return true
    })

    if (unknownPaths.length > 0) {
      return {
        status: 'warn',
        reason: `Unknown paths mentioned: ${unknownPaths.slice(0, 3).join(', ')}`,
      }
    }

    return { status: 'pass' }
  }
}
```

- [ ] **Step 4: Write consistency.ts**

```ts
// src/modules/hallucination/consistency.ts
import type { HallucinationCheckResult } from './factual'

export class ConsistencyCheck {
  private decisions: Array<{ decision: string; location: string }> = []
  private createdFiles: Set<string> = new Set()
  private deletedFiles: Set<string> = new Set()

  trackDecision(decision: string, location: string): void {
    this.decisions.push({ decision, location })
  }

  trackCreatedFile(path: string): void {
    this.createdFiles.add(path)
  }

  trackDeletedFile(path: string): void {
    this.deletedFiles.add(path)
  }

  getCreatedFiles(): string[] {
    return Array.from(this.createdFiles)
  }

  validate(response: string): HallucinationCheckResult {
    const lower = response.toLowerCase()

    for (const d of this.decisions) {
      const decisionWords = d.decision.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      const contradicts = decisionWords.some(word =>
        lower.includes(`instead of ${word}`) || lower.includes(`not ${word}`)
      )
      if (contradicts) {
        return {
          status: 'warn',
          reason: `Contradicts previous decision: "${d.decision}" in ${d.location}`,
        }
      }
    }

    return { status: 'pass' }
  }
}
```

- [ ] **Step 5: Write confidence.ts**

```ts
// src/modules/hallucination/confidence.ts
import type { HallucinationCheckResult } from './factual'

const UNCERTAINTY_MARKERS = ['i think', 'maybe', 'probably', 'i believe', 'not sure', 'might be']
const MIN_TOKENS = 10

export class ConfidenceCheck {
  private previousResponse: string = ''

  setPreviousResponse(response: string): void {
    this.previousResponse = response
  }

  validate(response: string): HallucinationCheckResult {
    if (!response || response.length < MIN_TOKENS) {
      return { status: 'retry', reason: 'Response too short or empty' }
    }

    if (this.previousResponse) {
      const overlap = this.calculateOverlap(response, this.previousResponse)
      if (overlap > 0.5) {
        return { status: 'retry', reason: `Response too repetitive (${Math.round(overlap * 100)}% overlap)` }
      }
    }

    const lower = response.toLowerCase()
    const foundMarkers = UNCERTAINTY_MARKERS.filter(m => lower.includes(m))
    if (foundMarkers.length > 0) {
      return { status: 'warn', reason: `Uncertainty markers: ${foundMarkers.join(', ')}` }
    }

    return { status: 'pass' }
  }

  private calculateOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/))
    const wordsB = b.toLowerCase().split(/\s+/)
    if (wordsB.length === 0) return 0
    const matches = wordsB.filter(w => wordsA.has(w))
    return matches.length / wordsB.length
  }
}
```

- [ ] **Step 6: Write detector.ts**

```ts
// src/modules/hallucination/detector.ts
import { FactualCheck, type HallucinationCheckResult } from './factual'
import { ConsistencyCheck } from './consistency'
import { ConfidenceCheck } from './confidence'

export class HallucinationDetector {
  private factual: FactualCheck
  private consistency: ConsistencyCheck
  private confidence: ConfidenceCheck

  constructor() {
    this.factual = new FactualCheck()
    this.consistency = new ConsistencyCheck()
    this.confidence = new ConfidenceCheck()
  }

  getFactualCheck(): FactualCheck {
    return this.factual
  }

  getConsistencyCheck(): ConsistencyCheck {
    return this.consistency
  }

  getConfidenceCheck(): ConfidenceCheck {
    return this.confidence
  }

  validate(response: string): HallucinationCheckResult {
    const confidenceResult = this.confidence.validate(response)
    if (confidenceResult.status === 'retry' || confidenceResult.status === 'block') {
      return confidenceResult
    }

    const factualResult = this.factual.validate(response)
    const consistencyResult = this.consistency.validate(response)

    const warnings: string[] = []
    if (factualResult.status === 'warn') warnings.push(factualResult.reason || '')
    if (consistencyResult.status === 'warn') warnings.push(consistencyResult.reason || '')
    if (confidenceResult.status === 'warn') warnings.push(confidenceResult.reason || '')

    if (warnings.length > 0) {
      return { status: 'warn', reason: warnings.join('; ') }
    }

    return { status: 'pass' }
  }
}
```

- [ ] **Step 7: Write hallucination/index.ts**

```ts
// src/modules/hallucination/index.ts
export { HallucinationDetector } from './detector'
export { FactualCheck } from './factual'
export { ConsistencyCheck } from './consistency'
export { ConfidenceCheck } from './confidence'
export type { HallucinationCheckResult } from './factual'
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test tests/hallucination-factual.test.ts tests/hallucination-consistency.test.ts tests/hallucination-confidence.test.ts`
Expected: PASS

- [ ] **Step 9: Write detector test**

```ts
// tests/hallucination-detector.test.ts
import { describe, it, expect } from 'vitest'
import { HallucinationDetector } from '../src/modules/hallucination/detector'

describe('HallucinationDetector', () => {
  it('should pass on normal response', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('This is a normal response about the codebase.')
    expect(result.status).toBe('pass')
  })

  it('should retry on empty', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('')
    expect(result.status).toBe('retry')
  })

  it('should warn on unknown paths', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('I modified src/unknown-file.ts')
    expect(result.status).toBe('warn')
  })

  it('should warn on uncertainty', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('I think maybe we should use this approach.')
    expect(result.status).toBe('warn')
  })

  it('should aggregate multiple warnings', () => {
    const detector = new HallucinationDetector()
    const result = detector.validate('I think maybe we changed src/mystery.ts')
    expect(result.status).toBe('warn')
  })
})
```

- [ ] **Step 10: Run detector test**

Run: `bun test tests/hallucination-detector.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/modules/hallucination/ tests/hallucination-*.test.ts
git commit -m "feat: hallucination detection with factual, consistency, and confidence checks"
```

---

## Self-Review

**Spec coverage:**
- Dynamic budget calculation (Section 6.8) ✓
- Compaction at 75% history or 15 iterations (Section 6.8) ✓
- Keep last 6 turns, extract facts/decisions/errors (Section 6.8) ✓
- No second LLM call for compaction (Section 6.8) ✓
- SessionHistory: JSONL, search_history (Section 10.2) ✓
- Hallucination detection pipeline: pre-output validation (Section 6.9) ✓
- Factual check: known paths vs mentioned (Section 6.9.1) ✓
- Consistency check: decision reversal (Section 6.9.2) ✓
- Confidence check: short/repetitive/uncertain (Section 6.9.3) ✓
- pass/warn/retry/block reactions (Section 6.9) ✓

**Placeholder scan:** No placeholders.

**Type consistency:** HallucinationCheckResult matches spec's 4-status system. ContextManager budget matches spec's table.
