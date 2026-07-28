export * from './config/index'
export * from './logger/index'
export * from './core/index'
export * from './llm/index'
export * from './tools/index'
export * from './migration/index'

import { MigrationDetector } from './migration/detect'
import { BackupManager } from './migration/backup'
import { homedir } from 'os'
import { join } from 'path'

export function checkMigration(configDir?: string): void {
  const dir = configDir || join(homedir(), '.mma')
  const detector = new MigrationDetector(dir)
  if (detector.needsMigration()) {
    const backup = new BackupManager(dir)
    backup.backupConfig()
    backup.backupAll()
    const summary = backup.getBackupSummary()
    console.log(`[MMA] ${summary}`)
  }
}
