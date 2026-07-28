import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readFileTool } from '../src/tools/read-file'

describe('read_file', () => {
  let tmpDir: string
  let ctx: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-test-'))
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } }
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      for (const f of ['test.txt', 'empty.txt']) {
        const p = join(tmpDir, f)
        if (existsSync(p)) unlinkSync(p)
      }
      rmdirSync(tmpDir)
    }
  })

  it('should read file content', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world')
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt') })
    expect(result.success).toBe(true)
    expect(result.output).toBe('hello world')
  })

  it('should read with offset and limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(tmpDir, 'test.txt'), lines)
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), offset: 3, limit: 2 })
    expect(result.success).toBe(true)
    expect(result.output).toContain('line 3')
    expect(result.output).toContain('line 4')
  })

  it('should handle nonexistent file', async () => {
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'nope.txt') })
    expect(result.success).toBe(false)
  })

  it('should enforce path safety', async () => {
    const result = await readFileTool.handler(ctx, { path: '../etc/passwd' })
    expect(result.success).toBe(false)
  })
})
