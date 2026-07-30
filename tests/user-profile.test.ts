import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { UserProfile } from '../src/modules/user-profile/profile'

describe('UserProfile', () => {
  let tmpDir: string
  let profile: UserProfile

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-profile-'))
    profile = new UserProfile(tmpDir)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should collect platform info', () => {
    const info = profile.collect()
    expect(info.platform).toBeDefined()
    expect(info.shell).toBeDefined()
    expect(info.os).toBeDefined()
  })

  it('should persist to disk', () => {
    profile.collect()
    profile.save()
    const savedPath = join(tmpDir, 'profile.json')
    expect(existsSync(savedPath)).toBe(true)
    const data = JSON.parse(readFileSync(savedPath, 'utf-8'))
    expect(data.platform).toBeDefined()
  })

  it('should load from disk', () => {
    profile.collect()
    profile.save()

    const profile2 = new UserProfile(tmpDir)
    profile2.load()
    expect(profile2.getInfo()!.platform).toBeDefined()
  })

  it('should compress to ~500 tokens', () => {
    profile.collect()
    const compressed = profile.compress()
    expect(compressed.length).toBeLessThan(2000)
    expect(compressed).toContain('OS:')
  })

  it('should set and get preferences', () => {
    profile.setPreference('editor', 'vscode')
    expect(profile.getPreference('editor')).toBe('vscode')
  })
})
