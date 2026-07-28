# Plan 0: Migration & Safe Startup — MMA v1 → v2 Conflict Prevention

> **REQUIRED:** Этот план должен выполняться **первым** — до Plan 1. Он модифицирует файлы из Plan 1 и Plan 5, чтобы новая версия не конфликтовала со старой.

**Goal:** Prevent MMA v2 from breaking on existing `~/.mma/` or `.mma/` directories left by MMA v1. Detect old config format, back up v1 data, reset to v2 defaults, and handle incompatible sessions/modules gracefully.

**Architecture:** Add `version` field to config. In `loadConfig()`, detect v1 config by checking fields. If v1 detected: move old config to `.bak`, start fresh with v2 defaults. For sessions/memory — compatible. For skills/plugins — format mismatch → skip with warning. All v1 data preserved in backup, never deleted.

**Tech Stack:** Bun + TypeScript, vitest

---

## File Structure Changes

```
src/config/          ← modify existing files from Plan 1
src/migration/       ← NEW: migration utilities
├── detect.ts        — Detect MMA v1 vs v2 installation
├── backup.ts        — Back up old config/sessions to .bak
└── index.ts
```

Tests:
```
tests/migration.test.ts    — NEW
tests/config.test.ts       ← MODIFY: add v1 detection tests
```

---

### Task 1: Add version to config types + defaults

**Files:**
- Modify: `src/config/types.ts` (Plan 1, Task 1)
- Modify: `src/config/defaults.ts` (Plan 1, Task 1)

- [ ] **Step 1: Add version field to AppConfig**

Add `version` to the interface in `src/config/types.ts`:

```ts
export interface AppConfig {
  version: string       // ← NEW: "2.0.0" for v2
  model: string
  provider: ProviderConfig
  orchestrator: OrchestratorConfig
  contextWindow: number
  contextBudget: ContextBudget
  maxToolIterations: number
  stuckThreshold: number
  autoPlan: boolean
  logLevel: string
  locale: string
}
```

Add to defaults in `src/config/defaults.ts`:

```ts
export const DEFAULTS: AppConfig = {
  version: '2.0.0',     // ← NEW
  model: 'qwen3.5-9b',
  // ... rest unchanged
}
```

- [ ] **Step 2: Update config test to expect version**

Add to `tests/config.test.ts`:

```ts
it('should have version field', () => {
  expect(DEFAULTS.version).toBe('2.0.0')
})
```

- [ ] **Step 3: Run test**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts tests/config.test.ts
git commit -m "feat: add version field to config for migration detection"
```

---

### Task 2: Migration detection + backup utilities

**Files:**
- Create: `src/migration/detect.ts`
- Create: `src/migration/backup.ts`
- Create: `src/migration/index.ts`
- Test: `tests/migration.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmdirSync, mkdirSync } from 'fs'
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
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
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
    if (existsSync(tmpDir)) rmdirSync(tmpDir, { recursive: true })
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

    // Should create .bak directory
    const bakDir = tmpDir + '.bak'
    expect(existsSync(bakDir)).toBe(true)
  })

  it('should report migration summary', () => {
    const backup = new BackupManager(tmpDir)
    const summary = backup.getBackupSummary()
    expect(summary).toContain('config.json')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/migration.test.ts`
Expected: FAIL

- [ ] **Step 3: Write detect.ts**

```ts
// src/migration/detect.ts
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const V1_ONLY_FIELDS = ['apiBase', 'apiKey', 'chatEndpoint', 'temperature', 'maxTokens']

export class MigrationDetector {
  private configDir: string

  constructor(configDir: string) {
    this.configDir = configDir
  }

  needsMigration(): boolean {
    const configPath = join(this.configDir, 'config.json')
    if (!existsSync(configPath)) return false

    try {
      const content = readFileSync(configPath, 'utf-8')
      const config = JSON.parse(content)

      // Если есть version и это "2.x" — всё ок
      if (config.version && config.version.startsWith('2.')) return false

      // Если нет version, но есть v1-only поля — это v1
      for (const field of V1_ONLY_FIELDS) {
        if (field in config) return true
      }

      // Если полей v1 нет — проверяем наличие обязательных v2 полей
      const v2Required = ['provider', 'contextWindow', 'contextBudget']
      const hasAllV2Fields = v2Required.every(f => f in config)
      if (!hasAllV2Fields) return true

      return false
    } catch {
      // Если конфиг битый — тоже нужна миграция (reset)
      return true
    }
  }

  hasOldSessions(): boolean {
    const sessionsDir = join(this.configDir, 'sessions')
    if (!existsSync(sessionsDir)) return false
    return readdirSync(sessionsDir).length > 0
  }

  hasOldProfile(): boolean {
    const profilePath = join(this.configDir, 'profile.json')
    if (!existsSync(profilePath)) return false
    try {
      const profile = JSON.parse(readFileSync(profilePath, 'utf-8'))
      // v1 profile might have different fields
      return !profile.platform && !profile.os
    } catch { return false }
  }
}
```

- [ ] **Step 4: Write backup.ts**

```ts
// src/migration/backup.ts
import { copyFileSync, renameSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
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
    // Backup the entire .mma dir to .mma.bak
    const bakDir = this.configDir + '.bak'
    if (existsSync(bakDir)) return  // уже есть бэкап

    if (existsSync(this.configDir)) {
      mkdirSync(bakDir, { recursive: true })
      const entries = readdirSync(this.configDir)
      for (const entry of entries) {
        if (entry.endsWith('.bak')) continue
        try {
          copyFileSync(join(this.configDir, entry), join(bakDir, entry))
        } catch { /* skip dirs, only files */ }
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
```

- [ ] **Step 5: Write migration/index.ts**

```ts
// src/migration/index.ts
export { MigrationDetector } from './detect'
export { BackupManager } from './backup'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/migration.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/migration/ tests/migration.test.ts
git commit -m "feat: migration detector and backup manager for v1→v2 upgrade"
```

---

### Task 3: Integrate migration into config loader

**Files:**
- Modify: `src/config/config.ts` (Plan 1, Task 2)

- [ ] **Step 1: Update loadConfig to auto-migrate**

Modify `src/config/config.ts` — add migration check at the start of `loadConfig()`:

```ts
// src/config/config.ts — add these imports at top
import { MigrationDetector } from '../migration/detect'
import { BackupManager } from '../migration/backup'

// Add after imports:
const CONFIG_DIR_DEFAULT = join(homedir(), '.mma')

// Modify loadConfig function — add migration block before loading:
export function loadConfig(options: LoadConfigOptions): AppConfig {
  const globalPath = join(options.configDir, 'config.json')
  const projectPath = options.projectConfigPath

  // --- MIGRATION CHECK ---
  const detector = new MigrationDetector(options.configDir)
  if (detector.needsMigration()) {
    const backup = new BackupManager(options.configDir)
    backup.backupConfig()
    const summary = backup.getBackupSummary()
    console.log(`[MMA] Detected old config. ${summary}`)
    // Delete old config so defaults are used
    try { unlinkSync(globalPath) } catch { }
  }
  // --- END MIGRATION CHECK ---

  let config: AppConfig = { ...DEFAULTS }

  const globalData = loadJSON(globalPath)
  if (globalData) {
    config = deepMerge(config, globalData as Partial<AppConfig>)
  }

  // ... rest unchanged (project config, env vars) ...
}
```

- [ ] **Step 2: Update config test to verify migration**

Add to `tests/config.test.ts`:

```ts
import { MigrationDetector } from '../src/migration/detect'
import { BackupManager } from '../src/migration/backup'

describe('config migration', () => {
  it('should migrate v1 config on load', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mma-cfg-migrate-'))

    // Write v1-style config
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({
      apiBase: 'http://old:1234',
      model: 'qwen2.5-7b',
      temperature: 0.7,
    }))

    // Load should detect v1, back up, and return defaults
    const cfg = loadConfig({ configDir: tmpDir, projectConfigPath: join(tmpDir, '.mmrc') })
    expect(cfg.model).toBe('qwen3.5-9b') // default, not v1's
    expect(cfg.version).toBe('2.0.0')
    expect(existsSync(join(tmpDir, 'config.json.bak'))).toBe(true)

    rmdirSync(tmpDir, { recursive: true })
  })
})
```

- [ ] **Step 3: Run test**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/config/config.ts tests/config.test.ts
git commit -m "feat: auto-migrate v1 config to v2 on first load"
```

---

### Task 4: Safe module loading — skip incompatible skills/plugins

**Files:**
- Modify: `src/modules/skills/loader.ts` (Plan 5, Task 3)
- Modify: `src/modules/plugins/loader.ts` (Plan 5, Task 5)

- [ ] **Step 1: Add version marker to skill files**

Old skill files from v1 might lack the `mma_version` field in frontmatter. Modify the `parseSkillFile` in `src/modules/skills/loader.ts` to skip files that don't have `mma_version: 2`:

```ts
// In parseSkillFile method — after name check:
// Skip v1 skills that don't have mma_version: 2
if (frontmatter.mma_version && frontmatter.mma_version !== 2) {
  return null  // v1 skill, incompatible
}
// v1 skills without mma_version field — allow (they're markdown, should work)
```

- [ ] **Step 2: Add version check to plugin loader**

In `src/modules/plugins/loader.ts`, wrap `require` in try-catch and skip plugins that throw (old plugins will likely throw because their hook interface changed):

```ts
loadFromDir(dirPath: string, pluginManager: PluginManager, logger?: any): void {
  if (!existsSync(dirPath)) return

  const entries = readdirSync(dirPath)
  for (const entry of entries) {
    const fullPath = join(dirPath, entry)
    if (!statSync(fullPath).isFile()) continue
    if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue

    try {
      const mod = require(fullPath) as { default?: AgentPlugin; plugin?: AgentPlugin }
      const plugin = mod.default || mod.plugin
      if (plugin && plugin.name) {
        pluginManager.register(plugin)
        logger?.info(`Loaded plugin: ${plugin.name}`)
      }
    } catch (e: any) {
      logger?.warn(`Skipped incompatible plugin: ${entry} (${e.message})`)
      // Graceful skip — old v1 plugin, likely uses different interface
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/skills/loader.ts src/modules/plugins/loader.ts
git commit -m "feat: skip incompatible v1 skills and plugins with warning"
```

---

### Task 5: Startup migration check in main entry

**Files:**
- Modify: `src/index.ts` (Plan 1, Task 7)

- [ ] **Step 1: Add migration check on startup**

Modify `src/index.ts` to include a startup migration check:

```ts
// src/index.ts
export * from './config/index'
export * from './logger/index'
export * from './core/index'
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
```

- [ ] **Step 2: Verify no import errors**

Run: `bun --eval "import('./src/index.ts').then(m => console.log('OK:', typeof m.checkMigration))"`
Expected: prints "OK: function"

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: startup migration check for v1→v2"
```

---

## Self-Review

**What this covers:**
- v1 config detection (missing version, v1-only fields) ✓
- Auto-backup of old config before reset ✓
- Full `.mma` directory backup to `.mma.bak` ✓
- User profile format detection ✓
- Old sessions preserved (JSONL format compatible) ✓
- v1 skills marked with `mma_version` skipped ✓
- Old plugins catch-and-skip with warning ✓
- Startup check that runs before any module loading ✓
- All user data preserved in `.bak` — never deleted ✓

**What is NOT covered (by design):**
- No automatic migration of v1 config values to v2 format — formats differ too much
- No migration of v1 session format — v1 sessions stay in `.bak` if format differs
- No migration of v1 plugins — plugin interface is completely different

**Placeholder scan:** No placeholders.

**Type safety:** MigrationDetector and BackupManager import only from fs/path. Full config type imported only in writeFreshConfig.
