import { describe, expect, it } from 'bun:test'
import { SessionHistoryWriter } from '../../../src/modules/context/history'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('SessionHistoryWriter', () => {
  it('should append messages to JSONL file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-history-'))
    const writer = new SessionHistoryWriter(tempDir, 'test-session')

    writer.append({ role: 'user', content: 'hello', timestamp: '2025-01-01T00:00:00Z' })
    writer.append({ role: 'assistant', content: 'hi', timestamp: '2025-01-01T00:00:01Z' })

    const historyPath = join(tempDir, 'test-session', 'history.jsonl')
    expect(existsSync(historyPath)).toBe(true)

    const content = readFileSync(historyPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    rmSync(tempDir, { recursive: true, force: true })
  })
})
