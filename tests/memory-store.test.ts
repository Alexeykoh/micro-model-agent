import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MemoryStore } from '../src/modules/memory/store'

describe('MemoryStore', () => {
  let tmpDir: string
  let store: MemoryStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-mem-'))
    store = new MemoryStore(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should create memory files on first access', () => {
    const content = store.read('conventions')
    expect(content).toBeTruthy()
  })

  it('should write and read memory entries', () => {
    store.append('conventions', 'Use tabs for indentation')
    const content = store.read('conventions')
    expect(content).toContain('Use tabs for indentation')
  })

  it('should append timestamps to entries', () => {
    store.append('decisions', 'Use TypeScript')
    const content = store.read('decisions')
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('should search across all memory files', () => {
    store.append('conventions', 'Use tabs')
    store.append('decisions', 'Use TypeScript')
    store.append('errors', 'TypeError in parser')

    const results = store.search('Type')
    expect(results).toHaveLength(2)
  })

  it('should append structured rule', () => {
    store.appendRule('errors', 'write_file fails with ENOENT', 'Directory does not exist', 'Run create_dir before write_file')
    const content = store.read('errors')
    expect(content).toContain('write_file fails with ENOENT')
    expect(content).toContain('Directory does not exist')
    expect(content).toContain('Run create_dir before write_file')
  })
})
