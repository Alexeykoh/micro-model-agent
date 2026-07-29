import { describe, expect, it } from 'bun:test'
import { loadConfig } from '../../src/config/config'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('Config project file name', () => {
  it('should use .mmrc for project config', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mma-config-'))
    const configDir = join(tempDir, 'config')
    const projectDir = join(tempDir, 'project')

    mkdirSync(configDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    writeFileSync(join(projectDir, '.mmrc'), JSON.stringify({ model: 'test-model' }))

    const config = loadConfig({ configDir, projectConfigPath: join(projectDir, '.mmrc') })

    expect(config.model).toBe('test-model')

    rmSync(tempDir, { recursive: true, force: true })
  })
})
