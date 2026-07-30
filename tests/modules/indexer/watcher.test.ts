import { describe, expect, it } from 'bun:test'
import { Indexer } from '../../../src/modules/indexer/walker'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Indexer fs.watch', () => {
  it('should detect file changes via watch', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-indexer-'))
    const indexer = new Indexer(tempDir)

    let changeDetected = false
    indexer.watch((event, filename) => {
      changeDetected = true
    })

    await new Promise(resolve => setTimeout(resolve, 100))

    writeFileSync(join(tempDir, 'test.ts'), 'export const x = 1')

    await new Promise(resolve => setTimeout(resolve, 200))

    indexer.unwatch()

    expect(changeDetected).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
