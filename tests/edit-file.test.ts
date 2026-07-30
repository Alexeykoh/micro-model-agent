import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { editFileTool } from '../src/tools/edit-file'

describe('edit_file', () => {
  let tmpDir: string
  let ctx: any

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-test-'))
    ctx = { baseDir: tmpDir, config: {}, logger: { info: () => {}, error: () => {} } }
    writeFileSync(join(tmpDir, 'test.txt'), 'hello world')
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
  })

  it('should replace text in file', async () => {
    const result = await editFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), old: 'world', new: 'there' })
    expect(result.success).toBe(true)
    expect(readFileSync(join(tmpDir, 'test.txt'), 'utf-8')).toBe('hello there')
  })

  it('should return error when string not found', async () => {
    const result = await editFileTool.handler(ctx, { path: join(tmpDir, 'test.txt'), old: 'nonexistent', new: 'x' })
    expect(result.success).toBe(false)
  })

  it('should enforce path safety', async () => {
    const result = await editFileTool.handler(ctx, { path: '../outside.txt', old: 'x', new: 'y' })
    expect(result.success).toBe(false)
  })
})
