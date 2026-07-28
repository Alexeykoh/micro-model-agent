import { copyFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppConfig } from '../config/types'

export class BackupManager {
  private configDir: string

  constructor(configDir: string) {
    this.configDir = configDir
  }

  backupConfig(): void {
    const configPath = join(this.configDir, 'config.json')
    if (!existsSync(configPath)) return

    const bakPath = join(this.configDir, 'config.json.bak')
    copyFileSync(configPath, bakPath)
  }

  backupAll(): void {
    const bakDir = this.configDir + '.bak'
    if (existsSync(bakDir)) return

    if (existsSync(this.configDir)) {
      mkdirSync(bakDir, { recursive: true })
      const entries = readdirSync(this.configDir)
      for (const entry of entries) {
        if (entry.endsWith('.bak')) continue
        try {
          copyFileSync(join(this.configDir, entry), join(bakDir, entry))
        } catch { /* skip dirs */ }
      }
    }
  }

  writeFreshConfig(config: AppConfig): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true })
    }
    writeFileSync(
      join(this.configDir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    )
  }

  getBackupSummary(): string {
    const lines: string[] = []
    const bakConfig = join(this.configDir, 'config.json.bak')
    const bakDir = this.configDir + '.bak'

    if (existsSync(bakConfig)) {
      lines.push(`- config → config.json.bak`)
    }
    if (existsSync(bakDir)) {
      const files = readdirSync(bakDir)
      lines.push(`- .mma/ → .mma.bak/ (${files.length} files)`)
    }

    return lines.length > 0
      ? `Migrated:\n${lines.join('\n')}`
      : 'No migration needed'
  }
}
