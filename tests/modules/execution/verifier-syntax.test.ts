import { describe, expect, it } from 'bun:test'
import { StepVerifier } from '../../../src/modules/execution/verifier'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('StepVerifier syntax validation', () => {
  it('should validate TypeScript syntax for valid files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-verify-'))
    const verifier = new StepVerifier(tempDir)

    writeFileSync(join(tempDir, 'test.ts'), 'export const x: number = 1')

    const result = await verifier.verifyStep('Create test.ts')

    expect(result.syntaxValid).toBe(true)
    expect(result.passed).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })

  it('should detect missing files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-verify-'))
    const verifier = new StepVerifier(tempDir)

    const result = await verifier.verifyStep('Create nonexistent.ts')

    expect(result.passed).toBe(false)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
