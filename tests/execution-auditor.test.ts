import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
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
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should pass when all step files exist', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
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
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/index.ts'), '')

    const plan = PlanCreator.createPlan('test', ['Create src/index.ts'])
    plan.steps[0].status = 'done'

    const result = await auditor.audit(plan)
    expect(result.summary).toMatch(/complete/i)
  })
})
