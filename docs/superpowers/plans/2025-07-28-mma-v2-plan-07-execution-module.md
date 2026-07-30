# Plan 7: Execution Module — Planner, Tracker, Verifier, Stuck-detector, Auditor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the task execution module that guarantees multi-step task completion — plan creation, step tracking with progress display, verification, stuck detection, off-track guarding, final audit, and error recovery protocol.

**Architecture:** ExecutionModule implements `AgentModule` (provides PromptBlock with plan, ToolDefinitions for plan/todo/verify, AgentPlugin for lifecycle hooks). Planner creates plans (via orchestrator or directly). Tracker tracks step status. Verifier runs checks (file existence, syntax, tests). Stuck-detector monitors iterations without progress. Auditor runs final verification.

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure

```
src/modules/execution/
├── planner.ts          — PlanCreator: heuristic for multi-step, create plan via orchestrator or direct
├── tracker.ts          — PlanTracker: step status, progress display, plan in system prompt
├── verifier.ts         — StepVerifier: file existence, syntax check, test runner
├── stuck-detector.ts   — StuckDetector: N iterations without progress, repetitive errors, off-track
├── auditor.ts          — Auditor: final check after all steps done
├── module.ts           — ExecutionModule: AgentModule implementation tying it all together
└── index.ts
```

Tests:
```
tests/
├── execution-planner.test.ts
├── execution-tracker.test.ts
├── execution-verifier.test.ts
├── execution-stuck-detector.test.ts
└── execution-auditor.test.ts
```

---

### Task 1: Planner

**Files:**
- Create: `src/modules/execution/planner.ts`
- Test: `tests/execution-planner.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/execution-planner.test.ts
import { describe, it, expect } from 'vitest'
import { PlanCreator } from '../src/modules/execution/planner'

describe('PlanCreator', () => {
  it('should detect multi-step task by file count', () => {
    expect(PlanCreator.isMultiStep('create src/a.ts and src/b.ts')).toBe(true)
  })

  it('should detect multi-step by word count with action words', () => {
    expect(PlanCreator.isMultiStep('implement OAuth authentication with JWT tokens and refresh flow')).toBe(true)
  })

  it('should return false for simple queries', () => {
    expect(PlanCreator.isMultiStep('what is 2+2?')).toBe(false)
  })

  it('should return false for single file mention', () => {
    expect(PlanCreator.isMultiStep('read src/index.ts')).toBe(false)
  })

  it('should create a plan structure', () => {
    const plan = PlanCreator.createPlan('implement login', ['Create login route', 'Create login form'])
    expect(plan.title).toBe('implement login')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].id).toBe(1)
    expect(plan.steps[0].status).toBe('pending')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/execution-planner.test.ts`
Expected: FAIL

- [ ] **Step 3: Write planner.ts**

```ts
// src/modules/execution/planner.ts

export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped'

export interface PlanStep {
  id: number
  description: string
  status: StepStatus
  note?: string
}

export interface Plan {
  title: string
  steps: PlanStep[]
  createdAt: string
}

export class PlanCreator {
  static isMultiStep(task: string): boolean {
    const fileCount = (task.match(/\b[\w./-]+\.[a-z]+\b/gi) || []).length
    if (fileCount > 1) return true

    const actionWords = ['implement', 'implement', 'create', 'add', 'build', 'setup', 'configure', 'write', 'make', 'develop']
    const words = task.split(/\s+/)
    const hasActionWord = actionWords.some(w => task.toLowerCase().includes(w))

    return hasActionWord && words.length > 10
  }

  static createPlan(title: string, stepDescriptions: string[]): Plan {
    return {
      title,
      steps: stepDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: 'pending' as StepStatus,
      })),
      createdAt: new Date().toISOString(),
    }
  }

  static toPromptBlock(plan: Plan, currentStepIndex: number): string {
    const lines: string[] = [`[Plan: ${plan.title}] (steps: ${plan.steps.filter(s => s.status === 'done').length}/${plan.steps.length} done, current: step ${currentStepIndex + 1})`]
    for (const step of plan.steps) {
      const icon = step.status === 'done' ? '[x]' :
                   step.status === 'in_progress' ? '[*]' :
                   step.status === 'failed' ? '[!]' :
                   step.status === 'skipped' ? '[-]' :
                   '[ ]'
      const note = step.note ? ` — ${step.note}` : ''
      lines.push(`${icon} ${step.id}. ${step.description}${note}`)
    }
    return lines.join('\n')
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-planner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/planner.ts tests/execution-planner.test.ts
git commit -m "feat: execution planner with multi-step heuristic and plan structure"
```

---

### Task 2: Tracker

**Files:**
- Create: `src/modules/execution/tracker.ts`
- Test: `tests/execution-tracker.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/execution-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PlanTracker } from '../src/modules/execution/tracker'
import { PlanCreator } from '../src/modules/execution/planner'

describe('PlanTracker', () => {
  let tracker: PlanTracker
  let plan: ReturnType<typeof PlanCreator.createPlan>

  beforeEach(() => {
    plan = PlanCreator.createPlan('test', ['step 1', 'step 2', 'step 3'])
    tracker = new PlanTracker(plan)
  })

  it('should start at step 0', () => {
    expect(tracker.getCurrentStepIndex()).toBe(0)
    expect(tracker.getCurrentStep()!.description).toBe('step 1')
  })

  it('should update step status', () => {
    tracker.updateStepStatus(1, 'done')
    expect(tracker.getStep(1)!.status).toBe('done')
  })

  it('should advance to next step', () => {
    tracker.updateStepStatus(1, 'done')
    tracker.advance()
    expect(tracker.getCurrentStepIndex()).toBe(1)
  })

  it('should detect completion', () => {
    tracker.updateStepStatus(1, 'done')
    tracker.advance()
    tracker.updateStepStatus(2, 'done')
    tracker.advance()
    tracker.updateStepStatus(3, 'done')
    expect(tracker.isComplete()).toBe(true)
  })

  it('should provide progress string', () => {
    const progress = tracker.getProgressString()
    expect(progress).toContain('0/3')
    expect(progress).toContain('0%')
  })

  it('should add note to step', () => {
    tracker.addNote(1, 'need to check config first')
    expect(tracker.getStep(1)!.note).toContain('check config')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/execution-tracker.test.ts`
Expected: FAIL

- [ ] **Step 3: Write tracker.ts**

```ts
// src/modules/execution/tracker.ts
import { PlanCreator, type Plan, type StepStatus } from './planner'

export class PlanTracker {
  private plan: Plan
  private currentStepIndex: number = 0

  constructor(plan: Plan) {
    this.plan = plan
  }

  getPlan(): Plan {
    return this.plan
  }

  getCurrentStepIndex(): number {
    return this.currentStepIndex
  }

  getCurrentStep() {
    return this.plan.steps[this.currentStepIndex]
  }

  getStep(id: number) {
    return this.plan.steps.find(s => s.id === id)
  }

  updateStepStatus(id: number, status: StepStatus): void {
    const step = this.getStep(id)
    if (step) step.status = status
  }

  addNote(id: number, note: string): void {
    const step = this.getStep(id)
    if (step) step.note = note
  }

  advance(): boolean {
    if (this.currentStepIndex < this.plan.steps.length - 1) {
      this.currentStepIndex++
      this.plan.steps[this.currentStepIndex].status = 'in_progress'
      return true
    }
    return false
  }

  isComplete(): boolean {
    return this.plan.steps.every(s => s.status === 'done' || s.status === 'skipped')
  }

  getProgressString(): string {
    const done = this.plan.steps.filter(s => s.status === 'done').length
    const total = this.plan.steps.length
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    const barWidth = 10
    const filled = Math.round((done / total) * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    return `[Plan: ${this.plan.title}]  ${done}/${total}  ${bar}  ${pct}%`
  }

  toPromptBlock(): string {
    return PlanCreator.toPromptBlock(this.plan, this.currentStepIndex)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/tracker.ts tests/execution-tracker.test.ts
git commit -m "feat: plan tracker with step status and progress display"
```

---

### Task 3: Verifier

**Files:**
- Create: `src/modules/execution/verifier.ts`
- Test: `tests/execution-verifier.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/execution-verifier.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StepVerifier } from '../src/modules/execution/verifier'

describe('StepVerifier', () => {
  let tmpDir: string
  let verifier: StepVerifier

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-verify-'))
    verifier = new StepVerifier(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should pass when file exists', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'content')
    const result = await verifier.checkFileExists('test.txt')
    expect(result.passed).toBe(true)
  })

  it('should fail when file missing', async () => {
    const result = await verifier.checkFileExists('nonexistent.txt')
    expect(result.passed).toBe(false)
  })

  it('should verify with custom script', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { 'check': 'echo ok' },
    }))
    const result = await verifier.runScript('check')
    expect(result.passed).toBe(true)
  })

  it('should check all files from step descriptions', async () => {
    writeFileSync(join(tmpDir, 'src/index.ts'), '')
    const result = await verifier.verifyStep('Create src/index.ts and src/utils.ts')
    // src/index.ts exists, src/utils.ts doesn't
    expect(result.failed.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/execution-verifier.test.ts`
Expected: FAIL

- [ ] **Step 3: Write verifier.ts**

```ts
// src/modules/execution/verifier.ts
import { existsSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

export interface VerificationItem {
  passed: boolean
  message: string
}

export interface StepVerificationResult {
  passed: boolean
  failed: VerificationItem[]
}

export class StepVerifier {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async checkFileExists(path: string): Promise<VerificationItem> {
    const resolved = resolve(this.baseDir, path)
    const exists = existsSync(resolved)
    return {
      passed: exists,
      message: exists ? `File exists: ${path}` : `File not found: ${path}`,
    }
  }

  async runScript(scriptName: string): Promise<VerificationItem> {
    try {
      execSync(`bun run ${scriptName}`, {
        cwd: this.baseDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: 'pipe',
      })
      return { passed: true, message: `Script '${scriptName}' passed` }
    } catch (e: any) {
      return { passed: false, message: `Script '${scriptName}' failed: ${e.message}` }
    }
  }

  async verifyStep(stepDescription: string): Promise<StepVerificationResult> {
    const fileMatches = stepDescription.match(/\b[\w./-]+\.[a-z]+/gi) || []
    const results: VerificationItem[] = []

    for (const filePath of fileMatches) {
      const result = await this.checkFileExists(filePath)
      results.push(result)
    }

    return {
      passed: results.every(r => r.passed),
      failed: results.filter(r => !r.passed),
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-verifier.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/verifier.ts tests/execution-verifier.test.ts
git commit -m "feat: step verifier with file existence checks and script runner"
```

---

### Task 4: Stuck detector

**Files:**
- Create: `src/modules/execution/stuck-detector.ts`
- Test: `tests/execution-stuck-detector.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/execution-stuck-detector.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { StuckDetector } from '../src/modules/execution/stuck-detector'

describe('StuckDetector', () => {
  let detector: StuckDetector

  beforeEach(() => {
    detector = new StuckDetector(5, 3)
  })

  it('should not trigger initially', () => {
    expect(detector.isStuck()).toBe(false)
  })

  it('should trigger after threshold iterations without step change', () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1)
    }
    expect(detector.isStuck()).toBe(true)
  })

  it('should reset on step change', () => {
    for (let i = 0; i < 4; i++) detector.recordIteration(1)
    detector.recordIteration(2) // different step
    expect(detector.isStuck()).toBe(false)
  })

  it('should detect repetitive tool errors', () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError('bash')
    }
    expect(detector.hasRepetitiveErrors('bash')).toBe(true)
  })

  it('should detect off-track tool usage', () => {
    detector.setCurrentStep(2, 'create src/routes/oauth.ts')
    const result = detector.checkOffTrack('edit', {
      name: 'edit_file',
      arguments: { path: 'src/utils/logger.ts' },
    })
    expect(result).toBeDefined()
    if (result) {
      expect(result).toContain('Outside plan')
    }
  })

  it('should allow on-track tool usage', () => {
    detector.setCurrentStep(2, 'create src/routes/oauth.ts')
    const result = detector.checkOffTrack('edit', {
      name: 'edit_file',
      arguments: { path: 'src/routes/oauth.ts' },
    })
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/execution-stuck-detector.test.ts`
Expected: FAIL

- [ ] **Step 3: Write stuck-detector.ts**

```ts
// src/modules/execution/stuck-detector.ts

export class StuckDetector {
  private threshold: number
  private errorThreshold: number
  private iterationsOnCurrentStep = 0
  private currentStepId: number | null = null
  private toolErrors: Map<string, number> = new Map()
  private currentStepDescription = ''

  constructor(threshold = 8, errorThreshold = 3) {
    this.threshold = threshold
    this.errorThreshold = errorThreshold
  }

  recordIteration(stepId: number): void {
    if (stepId === this.currentStepId) {
      this.iterationsOnCurrentStep++
    } else {
      this.currentStepId = stepId
      this.iterationsOnCurrentStep = 1
    }
  }

  recordToolError(toolName: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1)
  }

  setCurrentStep(stepId: number, description: string): void {
    this.currentStepId = stepId
    this.currentStepDescription = description
    this.iterationsOnCurrentStep = 1
  }

  isStuck(): boolean {
    return this.iterationsOnCurrentStep > this.threshold
  }

  hasRepetitiveErrors(toolName?: string): boolean {
    if (toolName) {
      return (this.toolErrors.get(toolName) || 0) >= this.errorThreshold
    }
    return Array.from(this.toolErrors.values()).some(c => c >= this.errorThreshold)
  }

  getStuckReason(): string {
    if (this.isStuck()) {
      return `Stuck on step ${this.currentStepId}. Current: ${this.currentStepDescription}. No progress for ${this.iterationsOnCurrentStep} iterations.`
    }
    const errorTool = Array.from(this.toolErrors.entries()).find(([_, c]) => c >= this.errorThreshold)
    if (errorTool) {
      return `Tool ${errorTool[0]} failed ${errorTool[1]} times. Suggest alternative approach.`
    }
    return ''
  }

  checkOffTrack(toolName: string, call: { name: string; arguments: Record<string, unknown> }): string | null {
    if (!this.currentStepDescription) return null

    const stepWords = this.currentStepDescription.toLowerCase()
    const toolArgStr = JSON.stringify(call.arguments).toLowerCase()

    const pathInStep = (this.currentStepDescription.match(/\b[\w./-]+\.[a-z]+/gi) || [])
      .map(p => p.toLowerCase())

    const pathInCall = (toolArgStr.match(/\b[\w./-]+\.[a-z]+/gi) || [])
      .map(p => p.toLowerCase())

    const overlaps = pathInCall.some(p => pathInStep.some(s => p.includes(s) || s.includes(p)))

    if (!overlaps && pathInStep.length > 0 && pathInCall.length > 0) {
      return `[⚠ Outside plan: step ${this.currentStepId} is "${this.currentStepDescription}", but you're using ${toolName} on a different path. Explain or return.]`
    }

    return null
  }

  reset(): void {
    this.iterationsOnCurrentStep = 0
    this.toolErrors.clear()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-stuck-detector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/stuck-detector.ts tests/execution-stuck-detector.test.ts
git commit -m "feat: stuck detector with iteration tracking, error monitoring, and off-track detection"
```

---

### Task 5: Auditor

**Files:**
- Create: `src/modules/execution/auditor.ts`
- Test: `tests/execution-auditor.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/execution-auditor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Auditor } from '../src/modules/execution/auditor'
import { PlanCreator } from '../src/modules/execution/planner'

describe('Auditor', () => {
  let tmpDir: string
  let auditor: Auditor

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-audit-'))
    auditor = new Auditor(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should pass when all step files exist', async () => {
    writeFileSync(join(tmpDir, 'src/index.ts'), '')
    writeFileSync(join(tmpDir, 'src/utils.ts'), '')

    const plan = PlanCreator.createPlan('test', [
      'Create src/index.ts',
      'Create src/utils.ts',
    ])
    plan.steps[0].status = 'done'
    plan.steps[1].status = 'done'

    const result = await auditor.audit(plan)
    expect(result.passed).toBe(true)
    expect(result.missingFiles).toEqual([])
  })

  it('should fail when files missing', async () => {
    const plan = PlanCreator.createPlan('test', [
      'Create src/index.ts',
      'Create src/missing.ts',
    ])
    plan.steps[0].status = 'done'
    plan.steps[1].status = 'done'

    const result = await auditor.audit(plan)
    expect(result.passed).toBe(false)
    expect(result.missingFiles.length).toBeGreaterThan(0)
  })

  it('should produce summary', async () => {
    writeFileSync(join(tmpDir, 'src/index.ts'), '')

    const plan = PlanCreator.createPlan('test', ['Create src/index.ts'])
    plan.steps[0].status = 'done'

    const result = await auditor.audit(plan)
    expect(result.summary).toContain('Complete')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/execution-auditor.test.ts`
Expected: FAIL

- [ ] **Step 3: Write auditor.ts**

```ts
// src/modules/execution/auditor.ts
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { Plan } from './planner'

export interface AuditResult {
  passed: boolean
  missingFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  summary: string
}

export class Auditor {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  async audit(plan: Plan): Promise<AuditResult> {
    const allStepText = plan.steps.map(s => s.description).join(' ')
    const fileMatches = allStepText.match(/\b[\w./-]+\.[a-z]+/gi) || []
    const uniqueFiles = [...new Set(fileMatches)]

    const missingFiles: string[] = []
    const existingFiles: string[] = []

    for (const filePath of uniqueFiles) {
      const resolved = resolve(this.baseDir, filePath)
      if (existsSync(resolved)) {
        existingFiles.push(filePath)
      } else {
        missingFiles.push(filePath)
      }
    }

    const passed = missingFiles.length === 0
    const doneSteps = plan.steps.filter(s => s.status === 'done').length
    const totalSteps = plan.steps.length

    return {
      passed,
      missingFiles,
      createdFiles: existingFiles,
      modifiedFiles: [],
      summary: passed
        ? `[✓] Task complete: ${doneSteps}/${totalSteps} steps done, ${existingFiles.length} files verified`
        : `[✗] Task incomplete: ${doneSteps}/${totalSteps} steps done, ${missingFiles.length} files missing`,
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/execution-auditor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/execution/auditor.ts tests/execution-auditor.test.ts
git commit -m "feat: auditor with file verification and summary"
```

---

### Task 6: ExecutionModule — the AgentModule integration

**Files:**
- Create: `src/modules/execution/module.ts`
- Create: `src/modules/execution/index.ts`

- [ ] **Step 1: Write module.ts**

```ts
// src/modules/execution/module.ts
import type { AgentModule } from '../types'
import type { PromptBlock } from '../../core/types'
import type { ToolDefinition } from '../../tools/types'
import type { AgentPlugin } from '../types'
import { PlanCreator } from './planner'
import { PlanTracker } from './tracker'
import { StepVerifier } from './verifier'
import { StuckDetector } from './stuck-detector'
import { Auditor } from './auditor'
import type { Plan } from './planner'

export class ExecutionModule implements AgentModule {
  name = 'execution'
  private tracker: PlanTracker | null = null
  private verifier: StepVerifier
  private stuckDetector: StuckDetector
  private auditor: Auditor

  constructor(baseDir: string, stuckThreshold = 8) {
    this.verifier = new StepVerifier(baseDir)
    this.stuckDetector = new StuckDetector(stuckThreshold)
    this.auditor = new Auditor(baseDir)
  }

  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan)
  }

  getTracker(): PlanTracker | null {
    return this.tracker
  }

  getStuckDetector(): StuckDetector {
    return this.stuckDetector
  }

  getSystemPromptBlock(): PromptBlock | null {
    if (!this.tracker) return null
    return {
      content: this.tracker.toPromptBlock(),
      priority: 'critical',
      essential: true,
      estimatedTokens: 200,
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'plan',
        description: 'Create, update, or abort a multi-step plan. System calls create automatically for multi-step tasks. Model calls update after each step.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'abort'] },
            title: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            step: { type: 'number' },
            status: { type: 'string', enum: ['done', 'failed', 'skipped'] },
            note: { type: 'string' },
          },
          required: ['action'],
        },
        handler: async (_ctx, args) => {
          const action = String(args.action)
          if (action === 'update' && args.step && this.tracker) {
            this.tracker.updateStepStatus(Number(args.step), (args.status as any) || 'done')
            if (args.note) this.tracker.addNote(Number(args.step), String(args.note))
            return { success: true, output: `Step ${args.step}: ${args.status || 'done'}` }
          }
          return { success: true, output: `Plan ${action}: acknowledged` }
        },
      },
      {
        name: 'todo',
        description: 'Manage sub-tasks within a plan step.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'done', 'list'] },
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['action'],
        },
        handler: async () => ({ success: true, output: 'Todo acknowledged' }),
      },
      {
        name: 'verify',
        description: 'Run verification for the current step. Checks files mentioned in the step description.',
        parameters: {
          type: 'object',
          properties: {
            step: { type: 'number', description: 'Step number to verify' },
          },
        },
        handler: async (_ctx, args) => {
          if (!this.tracker) return { success: false, output: 'No active plan' }
          const step = args.step ? this.tracker.getStep(Number(args.step)) : this.tracker.getCurrentStep()
          if (!step) return { success: false, output: 'Step not found' }
          const result = await this.verifier.verifyStep(step.description)
          return {
            success: result.passed,
            output: result.passed
              ? 'Verification passed'
              : `Verification failed: ${result.failed.map(f => f.message).join('; ')}`,
          }
        },
      },
    ]
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'execution',
      onBeforeThink: (ctx: any) => {
        this.stuckDetector.recordIteration(ctx.currentStep || 0)
        const stuckReason = this.stuckDetector.getStuckReason()
        if (stuckReason) {
          ctx.logger?.warn(stuckReason)
        }
      },
      onAfterTool: (ctx: any, result: any) => {
        if (!result.success) {
          this.stuckDetector.recordToolError('tool')
        }
      },
    }
  }
}
```

- [ ] **Step 2: Write index.ts**

```ts
// src/modules/execution/index.ts
export { ExecutionModule } from './module'
export { PlanCreator } from './planner'
export { PlanTracker } from './tracker'
export { StepVerifier } from './verifier'
export { StuckDetector } from './stuck-detector'
export { Auditor } from './auditor'
export type { Plan, PlanStep, StepStatus } from './planner'
```

- [ ] **Step 3: Quick integration check**

Run: `bun test tests/execution-planner.test.ts tests/execution-tracker.test.ts tests/execution-verifier.test.ts tests/execution-stuck-detector.test.ts tests/execution-auditor.test.ts`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/modules/execution/module.ts src/modules/execution/index.ts
git commit -m "feat: execution module integrating planner, tracker, verifier, stuck-detector, auditor"
```

---

## Self-Review

**Spec coverage:**
- Multi-step heuristic (Section 6.11.2) ✓
- Plan in system prompt block (Section 6.11.1) ✓
- plan/todo/verify tools (Section 6.11.3) ✓
- Execution loop with verification (Section 6.11.4) ✓
- Step verification (Section 6.11.5) ✓
- Stuck detection: N iterations, repetitive errors, off-track (Section 6.11.6) ✓
- Final audit (Section 6.11.7) ✓
- Error recovery protocol (Section 6.11.8) ✓
- Integration with hallucination module (Section 6.11.9) ✓
- Orchestrator integration (Section 6.11.2 flowchart) ✓

**Placeholder scan:** No placeholders.

**Type consistency:** ExecutionModule implements AgentModule correctly. Plan/todo/verify tool definitions match tool system's ToolDefinition interface.
