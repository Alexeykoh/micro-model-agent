import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../src/modules/session/store'
import type { SessionMeta, SessionMessage } from '../src/modules/session/types'

describe('SessionStore', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-session-test-'))
    store = new SessionStore(tmpDir)
    store.init()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should create session directory on init', () => {
    expect(existsSync(tmpDir)).toBe(true)
  })

  it('should save and load meta', () => {
    const meta: SessionMeta = {
      id: 'test-001',
      name: 'Test Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      model: 'qwen/qwen3.5-9b',
      contextWindow: 32768,
      projectDir: '/some/project',
    }
    store.saveMeta('test-001', meta)
    const loaded = store.loadMeta('test-001')
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe('test-001')
    expect(loaded!.name).toBe('Test Session')
    expect(loaded!.projectDir).toBe('/some/project')
  })

  it('should return null for non-existent meta', () => {
    const loaded = store.loadMeta('nonexistent')
    expect(loaded).toBeNull()
  })

  it('should append and load history messages', () => {
    const msg1: SessionMessage = {
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    }
    const msg2: SessionMessage = {
      role: 'assistant',
      content: 'hi there',
      timestamp: new Date().toISOString(),
    }
    store.appendMessage('test-002', msg1)
    store.appendMessage('test-002', msg2)
    const history = store.loadHistory('test-002')
    expect(history).toHaveLength(2)
    expect(history[0].content).toBe('hello')
    expect(history[1].content).toBe('hi there')
  })

  it('should return empty array for session with no history', () => {
    expect(store.loadHistory('empty-session')).toEqual([])
  })

  it('should list sessions', () => {
    const meta1: SessionMeta = {
      id: 's1', name: 'S1', createdAt: '', updatedAt: '',
      messageCount: 0, model: '', contextWindow: 0, projectDir: '',
    }
    const meta2: SessionMeta = {
      id: 's2', name: 'S2', createdAt: '', updatedAt: '',
      messageCount: 0, model: '', contextWindow: 0, projectDir: '',
    }
    store.saveMeta('s1', meta1)
    store.saveMeta('s2', meta2)
    const list = store.listSessions()
    expect(list).toHaveLength(2)
    const ids = list.map(m => m.id).sort()
    expect(ids).toEqual(['s1', 's2'])
  })

  it('should delete a session', () => {
    store.saveMeta('to-delete', {
      id: 'to-delete', name: '', createdAt: '', updatedAt: '',
      messageCount: 0, model: '', contextWindow: 0, projectDir: '',
    })
    store.appendMessage('to-delete', { role: 'user', content: 'x', timestamp: '' })
    expect(store.sessionExists('to-delete')).toBe(true)
    store.deleteSession('to-delete')
    expect(store.sessionExists('to-delete')).toBe(false)
    expect(store.loadMeta('to-delete')).toBeNull()
  })

  it('should check session existence', () => {
    expect(store.sessionExists('ghost')).toBe(false)
    store.saveMeta('exists', {
      id: 'exists', name: '', createdAt: '', updatedAt: '',
      messageCount: 0, model: '', contextWindow: 0, projectDir: '',
    })
    expect(store.sessionExists('exists')).toBe(true)
  })

  it('should handle concurrent message appends', () => {
    const msg: SessionMessage = { role: 'user', content: 'line1', timestamp: '' }
    for (let i = 0; i < 100; i++) {
      store.appendMessage('concurrent', msg)
    }
    const history = store.loadHistory('concurrent')
    expect(history).toHaveLength(100)
  })

  it('should update meta after appending messages', () => {
    store.saveMeta('counter', {
      id: 'counter', name: '', createdAt: '', updatedAt: '',
      messageCount: 0, model: 'm1', contextWindow: 1000, projectDir: '',
    })
    for (let i = 0; i < 5; i++) {
      store.appendMessage('counter', { role: 'user', content: `msg${i}`, timestamp: '' })
    }
    const meta = store.loadMeta('counter')
    expect(meta!.messageCount).toBe(5)
  })
})
