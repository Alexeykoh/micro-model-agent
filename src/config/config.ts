import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULTS } from './defaults'
import { DEFAULT_SECURITY_CONFIG } from './security'
import { t } from '../i18n/index'
import type { AppConfig } from './types'
import { MigrationDetector } from '../migration/detect'
import { BackupManager } from '../migration/backup'
import { validateExpertConfig } from './experts'
import { ConfigEncryptor, isEncryptedString } from '../modules/security/encryption'

/**
 * When the user's config version is older than this, force-overwrite
 * the security bash settings with the current defaults.
 * This ensures critical security changes (like operator allowlists)
 * are applied even if the user has a saved config.
 */
const FORCE_SECURITY_UPDATE_VERSION = '2.1.0'

/**
 * Restore RegExp instances in dangerousPatterns that were serialized as {}
 * (pre-0.8.0 configs) or as {__regex, source, flags} (new format).
 * Falls back to default patterns for any entry that is not a real RegExp.
 */
function restoreDangerousPatterns(
  patterns: unknown,
  defaults: unknown,
): RegExp[] {
  const fallback = (Array.isArray(defaults) ? defaults : []) as RegExp[];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return fallback;
  }
  return patterns.map((p, i) => {
    if (p instanceof RegExp) return p;
    // If the pattern was serialized as {__regex, source, flags}, revive it
    if (p && typeof p === "object") {
      const { source, flags } = p as { source?: string; flags?: string };
      if (source && typeof source === "string") {
        try {
          return new RegExp(source, flags || "");
        } catch {
          // fall through
        }
      }
    }
    // Corrupted entry (e.g. serialized as {} pre-0.8.0): use default by index
    return fallback[i] || fallback[0] || p as RegExp;
  });
}

function deepMerge<T>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = { ...target as any }
  for (const key of Object.keys(source as object)) {
    const srcVal = (source as any)[key]
    const tgtVal = (target as any)[key]
    if (
      srcVal !== null && srcVal !== undefined &&
      typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal)
    } else if (srcVal !== undefined) {
      result[key] = srcVal
    }
  }
  return result as T
}

/**
 * JSON replacer that serializes RegExp objects as {__regex, source, flags}
 * so they survive JSON.stringify/parse round-trips.
 */
function regexReplacer(_key: string, value: unknown): unknown {
  if (value instanceof RegExp) {
    return { __regex: true, source: value.source, flags: value.flags };
  }
  return value;
}

/**
 * JSON reviver that restores RegExp objects serialized by regexReplacer.
 */
function regexReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__regex === true
  ) {
    const { source, flags } = value as { source: string; flags: string };
    try {
      return new RegExp(source, flags);
    } catch {
      return value;
    }
  }
  return value;
}

function loadJSON(path: string): Record<string, unknown> | null {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'), regexReviver as (key: string, value: unknown) => unknown) as Record<string, unknown>
    }
  } catch { /* ignore malformed files */ }
  return null
}

function applyEnvVars(config: AppConfig): AppConfig {
  const env = process.env
  const result = { ...config }

  if (env.MMA_MODEL) result.model = env.MMA_MODEL
  if (env.MMA_PROVIDER_TYPE) result.provider = { ...result.provider, type: env.MMA_PROVIDER_TYPE }
  if (env.MMA_PROVIDER_BASEURL) result.provider = { ...result.provider, baseUrl: env.MMA_PROVIDER_BASEURL }
  if (env.MMA_PROVIDER_APIKEY) result.provider = { ...result.provider, apiKey: env.MMA_PROVIDER_APIKEY }
  if (env.MMA_LOG_LEVEL) result.logLevel = env.MMA_LOG_LEVEL
  if (env.MMA_LOCALE) result.locale = env.MMA_LOCALE
  if (env.MMA_CONTEXT_WINDOW) result.contextWindow = parseInt(env.MMA_CONTEXT_WINDOW, 10)
  if (env.MMA_MAX_TOOL_ITERATIONS) result.maxToolIterations = parseInt(env.MMA_MAX_TOOL_ITERATIONS, 10)
  if (env.MMA_STUCK_THRESHOLD) result.stuckThreshold = parseInt(env.MMA_STUCK_THRESHOLD, 10)
  if (env.MMA_AUTO_PLAN) result.autoPlan = env.MMA_AUTO_PLAN === 'true'
  if (env.MMA_MOE_ENABLED) result.moe = { ...result.moe, enabled: env.MMA_MOE_ENABLED === 'true' }

  return result
}

/**
 * Force-update security settings when upgrading from an older version.
 * This overrides user config for critical security fields that must
 * match the current code defaults (e.g. dangerousOperators).
 */
function forceSecurityUpdate(config: AppConfig): AppConfig {
  const userVersion = config.version || '0.0.0'
  if (userVersion >= FORCE_SECURITY_UPDATE_VERSION) return config

  // Force-overwrite bash security with current defaults
  const security = config.security || {} as any
  const userBash = security.bash || {}
  security.bash = {
    ...DEFAULT_SECURITY_CONFIG.bash,
    // Keep user's custom blacklist additions, but ensure defaults are present
    blacklist: [...new Set([
      ...DEFAULT_SECURITY_CONFIG.bash.blacklist,
      ...(userBash.blacklist || []),
    ])],
    whitelist: userBash.whitelist || DEFAULT_SECURITY_CONFIG.bash.whitelist,
    dangerousFlags: [...new Set([
      ...DEFAULT_SECURITY_CONFIG.bash.dangerousFlags,
      ...(userBash.dangerousFlags || []),
    ])],
    // dangerousOperators: ALWAYS use defaults — user overrides are dangerous
    dangerousOperators: [...DEFAULT_SECURITY_CONFIG.bash.dangerousOperators],
    blockDangerousFlags: DEFAULT_SECURITY_CONFIG.bash.blockDangerousFlags,
    logCommands: DEFAULT_SECURITY_CONFIG.bash.logCommands,
  }
  config.security = security

  console.log(t('migration.security_updated', { from: userVersion, to: FORCE_SECURITY_UPDATE_VERSION }))
  return config
}

export interface LoadConfigOptions {
  configDir: string
  projectConfigPath: string
}

export function loadConfig(options: LoadConfigOptions): AppConfig {
  const globalPath = join(options.configDir, 'config.json')

  mkdirSync(options.configDir, { recursive: true })

  const detector = new MigrationDetector(options.configDir)
  if (detector.needsMigration()) {
    const backup = new BackupManager(options.configDir)
    backup.backupConfig()
    const summary = backup.getBackupSummary()
    console.log(t('migration.detected', { summary }))
    try { unlinkSync(globalPath) } catch { }
  }

  let config: AppConfig = { ...DEFAULTS }

  const globalData = loadJSON(globalPath)
  if (globalData) {
    config = deepMerge(config, globalData as Partial<AppConfig>)
  }

  if (!existsSync(globalPath)) {
    saveConfig(config, globalPath)
  }

  const projectData = loadJSON(options.projectConfigPath)
  if (projectData) {
    config = deepMerge(config, projectData as Partial<AppConfig>)
  }

  // Restore RegExp patterns in contentScan that may have been serialized
  // as {} in pre-0.8.0 config files, or merged from user config.
  if (config.security?.contentScan?.dangerousPatterns) {
    config.security.contentScan.dangerousPatterns = restoreDangerousPatterns(
      config.security.contentScan.dangerousPatterns,
      DEFAULT_SECURITY_CONFIG.contentScan.dangerousPatterns,
    );
  }

  // Force-update security settings when upgrading from older version
  config = forceSecurityUpdate(config)

  config = applyEnvVars(config)

  // Decrypt sensitive fields in the loaded config
  try {
    const encryptor = new ConfigEncryptor();
    const decrypted = encryptor.decrypt(config as unknown as Record<string, unknown>);
    // Merge decrypted sensitive fields back into config
    for (const key of Object.keys(decrypted)) {
      (config as any)[key] = decrypted[key];
    }
  } catch (e: any) {
    // If decryption fails, log a warning but continue with the config
    console.warn(t('config.decryption_warning', { error: e.message }));
  }

  // Update global audit notifier with config (done in bootstrap.ts)

  return config
}

export function validateConfig(config: AppConfig, allToolTags: string[]): void {
  const errors = validateExpertConfig(config, allToolTags)
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.join('\n')}`)
  }
}

export function saveConfig(config: AppConfig, configPath: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  
  // Encrypt sensitive fields before saving
  try {
    const encryptor = new ConfigEncryptor();
    const encryptedConfig = encryptor.encrypt({ ...config } as unknown as Record<string, unknown>);
    writeFileSync(configPath, JSON.stringify(encryptedConfig, regexReplacer, 2), 'utf-8')
  } catch (e: any) {
    // If encryption fails, save without encryption
    console.warn(t('config.encryption_warning', { error: e.message }));
    writeFileSync(configPath, JSON.stringify(config, regexReplacer, 2), 'utf-8')
  }
}
