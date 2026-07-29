import { describe, expect, it } from 'bun:test'
import { SessionStore } from '../../../src/modules/session/store'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SessionStore rotation', () => {
  it('should archive sessions older than 30 days', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-session-'))
    const store = new SessionStore(tempDir)
    store.init()

    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 31)
    const oldId = 'ses_old123'

    store.saveMeta(oldId, {
      id: oldId,
      name: 'Old Session',
      createdAt: oldDate.toISOString(),
      updatedAt: oldDate.toISOString(),
      messageCount: 5,
      model: 'test',
      contextWindow: 32768,
      projectDir: '/test',
    })

    writeFileSync(join(tempDir, oldId, 'history.jsonl'), '{"role":"user","content":"test"}\n')

    store.rotateOldSessions()

    const gzPath = join(tempDir, `${oldId}.jsonl.gz`)
    expect(existsSync(gzPath)).toBe(true)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
