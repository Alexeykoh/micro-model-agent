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
    expect(result.output).toContain('hello world')
  })

  it('should include full path and format in output header', async () => {
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world')
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt') })
    expect(result.success).toBe(true)
    expect(result.output).toContain(join(tmpDir, 'test.txt'))
    expect(result.output).toContain('.txt')
    expect(result.output).toContain('lines 1-1')
  })

  it('should read with offset and limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(tmpDir, 'test.txt'), lines)
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), offset: 3, limit: 2 })
    expect(result.success).toBe(true)
    expect(result.output).toContain('line 3')
    expect(result.output).toContain('line 4')
    expect(result.output).toContain('lines 3-4')
  })

  it('should chunk long files by default and suggest offset continuation', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(tmpDir, 'test.txt'), lines)
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt') })
    expect(result.success).toBe(true)
    expect(result.output).toContain('line 1')
    expect(result.output).toContain('line 300')
    expect(result.output).not.toContain('line 400')
    expect(result.output).toContain('offset=301')
    expect(result.output).toContain('1000 lines')
  })

  it('should not truncate when explicit limit covers the file', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(tmpDir, 'test.txt'), lines)
    const result = await readFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), limit: 100 })
    expect(result.success).toBe(true)
    expect(result.output).toContain('line 50')
    expect(result.output).not.toContain('offset=')
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
