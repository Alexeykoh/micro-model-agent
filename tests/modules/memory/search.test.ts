import { describe, expect, it } from 'bun:test'
import { MemorySearch } from '../../../src/modules/memory/search'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('MemorySearch', () => {
  it('should search across all memory files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-memory-'))
    writeFileSync(join(tempDir, 'conventions.md'), '# Conventions\n\n- Use TypeScript\n- Follow ESLint\n')
    writeFileSync(join(tempDir, 'decisions.md'), '# Decisions\n\n- Chose Bun runtime\n')

    const search = new MemorySearch(tempDir)
    const results = search.query('TypeScript')

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].file).toBe('conventions')
    expect(results[0].match).toContain('TypeScript')

    rmSync(tempDir, { recursive: true, force: true })
  })
})
