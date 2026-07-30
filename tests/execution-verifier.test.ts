import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { StepVerifier } from '../src/modules/execution/verifier'
import { DEFAULTS } from '../src/config/defaults'
import type { MoEPlan } from '../src/modules/execution/types'

describe('StepVerifier', () => {
  let tmpDir: string
  let verifier: StepVerifier

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-verify-'))
    verifier = new StepVerifier(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
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

  it('should check all files from step descriptions', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/index.ts'), '')
    const result = await verifier.verifyStep('Create src/index.ts and src/utils.ts')
    expect(result.failed.length).toBeGreaterThan(0)
  })

  it('should verify artifact files', async () => {
    writeFileSync(join(tmpDir, 'output.txt'), 'content')
    const results = await verifier.verifyArtifactFiles(['output.txt', 'missing.txt'])
    expect(results[0].passed).toBe(true)
    expect(results[1].passed).toBe(false)
  })

  it('should verify MoE manifest with file checks', async () => {
    const plan: MoEPlan = {
      title: 'Test',
      subtasks: [{
        id: 't1',
        description: 'Create files',
        expert_tag: 'code',
        allowed_files: ['test-output.txt'],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: '',
        success_criteria: [],
      }],
      shared_context: { rules: [], refs: [] },
    }

    writeFileSync(join(tmpDir, 'test-output.txt'), 'output')
    const result = await verifier.verifyMoEManifest(plan, DEFAULTS, ['file', 'code', 'shell', 'research', 'browser', 'vision', 'core'])
    expect(result.success).toBe(true)
  })

  it('should report missing artifact files', async () => {
    const plan: MoEPlan = {
      title: 'Test',
      subtasks: [{
        id: 't1',
        description: 'Create files',
        expert_tag: 'code',
        allowed_files: ['nonexistent.txt'],
        read_only_files: [],
        depends_on: [],
        input_from: [],
        expected_output: '',
        success_criteria: [],
      }],
      shared_context: { rules: [], refs: [] },
    }

    const result = await verifier.verifyMoEManifest(plan, DEFAULTS, ['file', 'code', 'shell', 'research', 'browser', 'vision', 'core'])
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
