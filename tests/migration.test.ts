import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MigrationDetector } from '../src/migration/detect'
import { BackupManager } from '../src/migration/backup'

describe('MigrationDetector', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-migrate-'))
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should detect v1 config by missing version field', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ model: 'qwen2.5-7b' }))
    const detector = new MigrationDetector(tmpDir)
    expect(detector.needsMigration()).toBe(true)
  })

  it('should not migrate v2 config', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ version: '2.0.0', model: 'qwen3.5-9b' }))
    const detector = new MigrationDetector(tmpDir)
    expect(detector.needsMigration()).toBe(false)
  })

  it('should detect v1 by known v1-only fields', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ apiBase: 'http://old:1234', model: 'old-model' }))
    const detector = new MigrationDetector(tmpDir)
    expect(detector.needsMigration()).toBe(true)
  })

  it('should not migrate empty dir', () => {
    const detector = new MigrationDetector(tmpDir)
    expect(detector.needsMigration()).toBe(false)
  })
})

describe('BackupManager', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-backup-'))
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({ model: 'v1-model' }))
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true })
    writeFileSync(join(tmpDir, 'sessions/test.jsonl'), '{"msg":"old session"}')
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('should backup config file', () => {
    const backup = new BackupManager(tmpDir)
    backup.backupConfig()
    expect(existsSync(join(tmpDir, 'config.json.bak'))).toBe(true)
    const bakContent = JSON.parse(readFileSync(join(tmpDir, 'config.json.bak'), 'utf-8'))
    expect(bakContent.model).toBe('v1-model')
  })

  it('should create fresh v2 config after backup', () => {
    const backup = new BackupManager(tmpDir)
    backup.backupConfig()
    backup.writeFreshConfig({ version: '2.0.0', model: 'qwen3.5-9b' } as any)
    const config = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf-8'))
    expect(config.version).toBe('2.0.0')
    expect(config.model).toBe('qwen3.5-9b')
  })

  it('should backup entire .mma directory when needed', () => {
    const backup = new BackupManager(tmpDir)
    backup.backupAll()
    const bakDir = tmpDir + '.bak'
    expect(existsSync(bakDir)).toBe(true)
  })

  it('should report migration summary', () => {
    const backup = new BackupManager(tmpDir)
    backup.backupConfig()
    const summary = backup.getBackupSummary()
    expect(summary).toContain('config.json.bak')
  })
})
