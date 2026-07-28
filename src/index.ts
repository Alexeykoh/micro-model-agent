import { MigrationDetector } from './migration'
import { BackupManager } from './migration'
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
