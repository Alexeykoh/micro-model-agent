import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Indexer } from '../src/modules/indexer/walker'

describe('Indexer', () => {
  let tmpDir: string
  let indexer: Indexer

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-idx-'))
    indexer = new Indexer(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should walk files and detect language', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    writeFileSync(join(tmpDir, 'src/index.ts'), 'export const x = 1')
    writeFileSync(join(tmpDir, 'src/utils.ts'), 'export function foo() {}')

    const result = await indexer.walk()
    expect(result.files).toHaveLength(2)
    expect(result.files.every((f: any) => f.language === 'typescript')).toBe(true)
  })

  it('should extract exports from TypeScript', async () => {
    writeFileSync(join(tmpDir, 'lib.ts'), `export const greet = (name: string) => \`Hello \${name}\`\nexport function add(a: number, b: number) { return a + b }`)

    const result = await indexer.walk()
    const file = result.files[0]
    expect(file.exports).toContain('greet')
    expect(file.exports).toContain('add')
  })

  it('should ignore node_modules', async () => {
    mkdirSync(join(tmpDir, 'node_modules'), { recursive: true })
    writeFileSync(join(tmpDir, 'node_modules/ignore.ts'), 'export const x = 1')
    writeFileSync(join(tmpDir, 'index.ts'), 'export const y = 2')

    const result = await indexer.walk()
    expect(result.files).toHaveLength(1)
  })

  it('should produce a summary string', async () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'export const a = 1')

    const result = await indexer.walk()
    const summary = indexer.summarize(result)
    expect(summary).toContain('1 files')
    expect(summary).toContain('typescript:1')
  })
})
