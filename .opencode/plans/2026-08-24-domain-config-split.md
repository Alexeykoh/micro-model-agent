# Plan: Split config into domain files

**Date:** 2026-08-24
**Status:** Proposed
**User request:** "Текущий вариант не удобный и сложный в настройке. Давай рассмотрим разделение одного большого конфига на несколько файлов."

## Problem

- `~/.mma/config.json` — 300+ строк, полный дамп всех значений (включая дефолты)
- `saveConfig()` пишет **полностью merged** объект — изменение `locale` генерирует 300 строк
- Непонятно что реально кастомизировано vs что дефолт
- 25 top-level ключей в одном файле — тяжело ориентироваться

## Design Decisions

1. **Legacy strategy:** Coexist + fallback — `config.json` читается как fallback, никогда не перезаписывается. Миграция опциональна через `mma config migrate`.
2. **File content:** Domain файлы содержат **полный набор** значений (не delta). Проще в реализации, каждый файл self-contained.
3. **AppConfig тип:** Единый, не меняется. Все потребители работают как раньше.

## Target structure

```
~/.mma/
├── config.json               # LEGACY — read as fallback, never auto-written, .bak after migration
├── config/
│   ├── core.json             # model, locale, contextWindow, contextBudget, modelLoad, etc.
│   ├── provider.json         # provider, orchestrator, retry, pricing
│   ├── moe.json              # moe, experts
│   ├── security.json         # security (bash, paths, network, contentScan, encryption, audit)
│   ├── browser.json          # browser
│   ├── search.json           # webSearch, errorWebSearch
│   ├── tools.json            # tools, subagent
│   ├── session.json          # session, sessionIsolation
│   ├── ui.json               # ui
│   ├── mcp.json              # mcpServers
│   ├── lsp.json              # lsp
│   ├── skills.json           # skills
│   └── updater.json          # updater
└── sessions/
```

## Domain mapping

| Domain | AppConfig keys | Approx lines |
|--------|---------------|--------------|
| `core` | `version`, `model`, `contextWindow`, `contextBudget`, `modelLoad`, `maxToolIterations`, `stuckThreshold`, `autoPlan`, `showReasoning`, `logLevel`, `locale` | ~30 |
| `provider` | `provider`, `orchestrator`, `retry`, `pricing` | ~40 |
| `moe` | `moe`, `experts` | ~25 |
| `security` | `security` | ~60 (RegExp patterns) |
| `browser` | `browser` | ~12 |
| `search` | `webSearch`, `errorWebSearch` | ~10 |
| `tools` | `tools`, `subagent` | ~15 |
| `session` | `session`, `sessionIsolation` | ~8 |
| `ui` | `ui` | ~8 |
| `mcp` | `mcpServers` | ~15 |
| `lsp` | `lsp` | ~40 (8 servers) |
| `skills` | `skills` | ~3 |
| `updater` | `updater` | ~5 |

## Loading pipeline

```
BEFORE:
  DEFAULTS → deepMerge(config.json) → deepMerge(.mmrc) → env vars → decrypt

AFTER:
  DEFAULTS → deepMerge(config.json) [LEGACY] → deepMerge(domain files) → deepMerge(.mmrc) → env vars → decrypt
```

- Domain файлы **всегда приоритетнее** config.json
- Если ни config.json ни domain files нет → чистые дефолты
- Если оба есть → domain files перезаписывают config.json значения

## Saving pipeline

```
BEFORE:
  encrypt → JSON.stringify → write config.json

AFTER:
  encrypt → для каждого домена: extract subset → JSON.stringify → write config/<domain>.json
```

- `saveConfig()` **всегда** пишет в domain файлы если `configDir` доступен
- `config.json` **никогда не перезаписывается** новым saveConfig
- Legacy `config.json` остаётся нетронутым (fallback для older versions)

## Migration notification

When a legacy `config.json` is detected without domain files, the user is notified and offered migration.

### Detection logic

In `loadConfig()`, track whether legacy was loaded:

```typescript
let legacyDetected = false;

// Step 2: legacy config.json
const globalData = loadJSON(globalPath);
if (globalData) {
  config = deepMerge(config, globalData);
  legacyDetected = true;  // ← NEW
}

// Step 3: domain files
const domainConfig = loadDomainFiles(options.configDir);
if (domainConfig) {
  config = deepMerge(config, domainConfig);
  legacyDetected = false;  // domain files exist → no migration needed
}

return { config, legacyDetected };
```

### Startup notification (REPL + CLI)

Return type changes: `loadConfig()` returns `{ config: AppConfig, legacyDetected: boolean }`.

In REPL startup (`repl.ts`), after bootstrap, if `legacyDetected`:

```
[INFO] Config: используется legacy config.json. Рекомендуется перейти к domain-формату:
       Run: mma config migrate
       Legacy файл останется как fallback (не удаляется).
```

In CLI one-shot mode (`main.ts`), same message to stderr (non-blocking, informational only).

### REPL `/config migrate` command

Interactive migration from inside REPL:

```
> /config migrate
[1/3] Reading ~/.mma/config.json ...
[2/3] Creating ~/.mma/config/ (13 domain files) ...
[3/3] Renaming config.json → config.json.bak
[OK] Миграция завершена. Legacy файл сохранён как config.json.bak.
```

### i18n keys (en + ru)

| Key | en | ru |
|-----|----|----|
| `config.legacy_hint` | `Config: using legacy config.json. Run "mma config migrate" to switch to domain format.` | `Config: используется legacy config.json. Запустите "mma config migrate" для перехода к domain-формату.` |
| `config.migrate_start` | `Migrating config to domain format...` | `Миграция конфига в domain-формат...` |
| `config.migrate_done` | `Migration complete. Created {count} domain files. Legacy saved as config.json.bak.` | `Миграция завершена. Создано {count} domain файлов. Legacy сохранён как config.json.bak.` |
| `config.migrate_no_legacy` | `No legacy config.json found. Already using domain format.` | `Legacy config.json не найден. Уже используется domain-формат.` |
| `config.migrate_error` | `Migration failed: {error}` | `Ошибка миграции: {error}` |

## Code changes

### 1. `src/config/domains.ts` (NEW, ~50 lines)

Mapping keys → domains + helpers:
- `CONFIG_DOMAINS` — the mapping constant
- `extractDomain(config, domain)` — extract subset of AppConfig for a domain
- `loadDomainFiles(configDir)` — read all `config/<domain>.json`, return merged object
- `saveDomainFiles(config, configDir)` — write each domain subset to its file
- `hasDomainFiles(configDir)` — check if `config/` directory has any domain files
- `getDomainFilePath(configDir, domain)` — resolve path for a domain file

### 2. `src/config/config.ts` — `loadConfig()`

Return type changes to `{ config: AppConfig, legacyDetected: boolean }`.

Full pipeline rewrite:

```typescript
export function loadConfig(options: LoadConfigOptions): { config: AppConfig; legacyDetected: boolean } {
  let config: AppConfig = { ...DEFAULTS };
  let legacyDetected = false;

  // 1. Migration check (v1 → v2) — runs BEFORE any domain logic
  //    MigrationDetector reads config.json directly, unchanged

  // 2. Legacy config.json (fallback)
  const globalPath = join(options.configDir, "config.json");
  const globalData = loadJSON(globalPath);  // uses regexReviver
  if (globalData) {
    config = deepMerge(config, globalData);
    legacyDetected = true;
  } else {
    // First run: auto-create domain files (NOT config.json)
    saveDomainFiles(config, options.configDir);
  }

  // 3. Domain files (override legacy)
  const domainConfig = loadDomainFiles(options.configDir);
  if (domainConfig) {
    config = deepMerge(config, domainConfig);
    legacyDetected = false;
  }

  // 4. Project .mmrc (override everything)
  const projectData = loadJSON(options.projectConfigPath);
  if (projectData) config = deepMerge(config, projectData);

  // 5. Post-load fixups — AFTER all merges
  restoreDangerousPatterns(config);
  normalizeLspServerArgs(config);

  // 6. Env vars + decrypt (unchanged)
  applyEnvVars(config);
  config = ConfigEncryptor().decrypt(config);

  return { config, legacyDetected };
}
```

**Key change:** Auto-creation now writes domain files instead of `config.json`.

### 3. `src/config/domains.ts` — RegExp handling per file

Each domain file must survive RegExp round-trip. `loadDomainFiles` uses `loadJSON` (which has `regexReviver`), `saveDomainFiles` uses `regexReplacer`:

```typescript
export function loadDomainFiles(configDir: string): Partial<AppConfig> | null {
  const configDirPath = join(configDir, "config");
  if (!existsSync(configDirPath)) return null;

  let result: Record<string, any> = {};
  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    const filePath = join(configDirPath, `${domain}.json`);
    if (!existsSync(filePath)) continue;
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw, regexReviver);  // ← revive RegExp per file
    result = deepMerge(result, data);
  }
  return Object.keys(result).length > 0 ? result as Partial<AppConfig> : null;
}

export function saveDomainFiles(config: AppConfig, configDir: string): void {
  const configDirPath = join(configDir, "config");
  mkdirSync(configDirPath, { recursive: true });

  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    const subset: Record<string, any> = {};
    for (const key of keys) {
      if ((config as any)[key] !== undefined) {
        subset[key] = (config as any)[key];
      }
    }
    if (Object.keys(subset).length === 0) continue;
    const filePath = join(configDirPath, `${domain}.json`);
    writeFileSync(filePath, JSON.stringify(subset, regexReplacer, 2));  // ← serialize RegExp per file
  }
}
```

### 4. `src/config/config.ts` — `saveConfig()`

Add `configDir?: string` parameter. When provided, writes domain files. When absent, writes legacy single file (backward compat for tests):

```typescript
export function saveConfig(config: AppConfig, configPath: string, configDir?: string): void {
  if (configDir) {
    saveDomainFiles(config, configDir);
    return;
  }
  // Legacy single-file write (unchanged)
  mkdirSync(dirname(configPath), { recursive: true });
  const encrypted = ConfigEncryptor().encrypt({...config});
  writeFileSync(configPath, JSON.stringify(encrypted, regexReplacer, 2));
}
```

### 5. Update all `saveConfig()` callsites (~12 locations)

Every callsite needs a `configDir` parameter. Centralize path resolution:

```typescript
// src/config/config.ts — new constant + helper
export const CONFIG_DIR = join(homedir(), ".mma");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const CONFIG_DOMAIN_DIR = join(CONFIG_DIR, "config");
```

Callsites to update (add `CONFIG_DIR` as third arg):
- `src/config/config.ts:209` — first-run auto-creation (now calls `saveDomainFiles` directly)
- `src/cli/main.ts:168` — setup wizard
- `src/cli/commands.ts:77,102,163,232,315,382` — config set, model use, context, provider use/add
- `src/cli/repl-commands.ts:270,391,416` — wizard, model use, provider use
- `src/cli/security-commands.ts:103,124,143,164,183` — security set-policy, enable/disable

### 6. Update `loadConfig()` callsites (~3 files)

Handle new return type `{ config, legacyDetected }`:
- `src/core/bootstrap.ts` — destructure, pass `legacyDetected` to BootstrapResult
- `src/cli/main.ts` — show notification if `legacyDetected`
- `src/cli/repl-commands.ts` — `/config reload` destructure new return

### 7. `/config reload` — fix shallow merge

Current code (`src/cli/repl-commands.ts:442`):
```typescript
Object.assign(ctx.config, freshConfig);  // SHALLOW — breaks domain partials
```

Fix to deepMerge:
```typescript
Object.assign(ctx.config, loadConfig(options).config);  // loadConfig returns full config
```

Actually, since `loadConfig` now returns the full merged config, the reload should just call `loadConfig` and replace the reference:
```typescript
const { config: freshConfig } = loadConfig(options);
Object.assign(ctx.config, freshConfig);  // safe: freshConfig is complete AppConfig
```

### 8. `src/cli/commands.ts` — `mma config migrate`

New CLI command:
1. Read `~/.mma/config.json` via `loadJSON` (with regexReviver)
2. Call `saveDomainFiles(config, configDir)`
3. Rename `config.json` → `config.json.bak`
4. Print list of created files

**Guard:** Abort if `config/` directory already has domain files (prevent double migration).

### 9. `src/cli/repl-commands.ts` — `/config migrate`

REPL slash command (interactive version):
1. Same logic as CLI but with progress output `[1/3] → [2/3] → [3/3] → [OK]`
2. Same guard against double migration

### 10. `src/cli/commands.ts` — `mma config set/show`

- `config set`: determine domain by key, read domain file, merge change, write domain file. Do NOT touch `config.json`.
- `config show`: iterate `config/` directory, show each domain file + its size, show legacy `config.json` flag if present

### 11. Centralized config path resolution

The `config.json` path is hardcoded in 12+ locations. Create a single source:

```typescript
// src/config/config.ts
export const CONFIG_DIR = join(homedir(), ".mma");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const CONFIG_DOMAIN_DIR = join(CONFIG_DIR, "config");
```

Replace all `join(homedir(), ".mma", "config.json")` references with `CONFIG_FILE`.

## What stays the same

- `AppConfig` type — single, 25 keys, all consumers work as before
- Project config `.mmrc` — deep-merge on top
- Env vars — applied after all merges
- Config encryption — whole-object level
- RegExp serialization — regexReplacer/regexReviver
- All imports — `import { AppConfig }` works as before

## Tests

| Test | Checks |
|------|--------|
| `loadDomainFiles` | Read 13 domain files, merge into one object |
| `saveDomainFiles` | Write AppConfig → 13 domain files |
| `extractDomain` | Correct key extraction per domain |
| `hasDomainFiles` | Returns true when `config/` has `.json` files |
| Legacy fallback | config.json read when domain files absent |
| Domain precedence | Domain files override config.json |
| Coexistence | config.json + domain files = domain wins |
| `legacyDetected` flag | true when config.json exists, false when domain files exist |
| `mma config migrate` | config.json → domain files + .bak |
| `mma config migrate` (no legacy) | Shows "no legacy found" message |
| `/config migrate` REPL | Same flow with progress output |
| `mma config set` | Write to correct domain file |
| Round-trip | save → load = identical object |

## Risks

| Risk | Mitigation |
|------|-----------|
| Encrypted keys break on split | `saveDomainFiles` encrypts per-file (existing `ConfigEncryptor`) |
| RegExp in security.json | `regexReplacer`/`regexReviver` applied per domain file (step 3) |
| config.json + domain files duplicate | Config.json never rewritten, domain wins on read |
| Tests break | `saveConfig` with empty `configDir` → legacy mode, tests untouched |
| `loadConfig()` return type change | All callsites updated in step 6; compile errors catch missing updates |
| Migration partial failure | Atomic: create all domain files first, then rename config.json |
| `/config reload` shallow merge | Replaced with `loadConfig()` return (full config) |
| Auto-creation writes config.json | Changed to write domain files on first run |
| Post-load fixups timing | Fixups run AFTER domain merge, not before |
| 12+ hardcoded config.json paths | Centralized to `CONFIG_FILE` / `CONFIG_DIR` constants |
| MigrationDetector reads only config.json | Runs before domain logic, unchanged; domain files are always v2 |
| `config show` RegExp serialization | Pass `regexReplacer` to `JSON.stringify` |
| Config by reference in modules | Fine — in-memory object unchanged, only storage format changes |

## Implementation order

| # | Task | Files |
|---|------|-------|
| 1 | `domains.ts` — mapping + extract/load/save helpers + RegExp handling | `src/config/domains.ts` |
| 2 | Centralized path constants (`CONFIG_DIR`, `CONFIG_FILE`, `CONFIG_DOMAIN_DIR`) | `src/config/config.ts` |
| 3 | `loadDomainFiles()` + `legacyDetected` flag + rewrite `loadConfig()` | `src/config/config.ts` |
| 4 | `saveDomainFiles()` + `configDir` param in `saveConfig()` | `src/config/config.ts` |
| 5 | Update all `saveConfig()` callsites — use `CONFIG_DIR` | 12+ locations |
| 6 | Update all `loadConfig()` callsites — handle `{ config, legacyDetected }` | `bootstrap.ts`, `main.ts`, `repl-commands.ts` |
| 7 | Fix `/config reload` shallow merge | `src/cli/repl-commands.ts` |
| 8 | `mma config migrate` CLI command | `src/cli/commands.ts` |
| 9 | `/config migrate` REPL command | `src/cli/repl-commands.ts` |
| 10 | Legacy hint notification at startup | `bootstrap.ts` or `repl.ts` |
| 11 | i18n keys for migration messages | `i18n/en.json`, `i18n/ru.json` |
| 12 | Update `mma config set/show` | `src/cli/commands.ts` |
| 13 | Tests | `tests/config-domains.test.ts` |
| 14 | AGENTS.md update | `AGENTS.md` |
