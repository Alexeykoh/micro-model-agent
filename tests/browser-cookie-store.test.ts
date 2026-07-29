import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { CookieStore } from '../src/modules/browser/cookie-store'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('CookieStore', () => {
  let dir: string
  let store: CookieStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-browser-test-'))
    store = new CookieStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves and loads cookies', async () => {
    const cookies = [
      { name: 'session', value: 'abc123', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'dark', domain: '.example.com', path: '/' },
    ]
    await store.save(cookies)
    const loaded = await store.load()
    expect(loaded).toEqual(cookies)
  })

  it('returns empty array when no file exists', async () => {
    const loaded = await store.load()
    expect(loaded).toEqual([])
  })

  it('saves to cookies.json file', async () => {
    await store.save([{ name: 'x', value: 'y', domain: '.test.com', path: '/' }])
    const filePath = join(dir, 'cookies.json')
    expect(existsSync(filePath)).toBe(true)
    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(content).toHaveLength(1)
    expect(content[0].name).toBe('x')
  })

  it('clears cookies', async () => {
    await store.save([{ name: 'x', value: 'y', domain: '.test.com', path: '/' }])
    await store.clear()
    const loaded = await store.load()
    expect(loaded).toEqual([])
  })
})
