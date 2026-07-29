import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { DEFAULTS } from './defaults'
import type { AppConfig } from './types'
import { MigrationDetector } from '../migration/detect'
import { BackupManager } from '../migration/backup'

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

function loadJSON(path: string): Record<string, unknown> | null {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
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

  return result
}

export interface LoadConfigOptions {
  configDir: string
  projectConfigPath: string
}

export function loadConfig(options: LoadConfigOptions): AppConfig {
  const globalPath = join(options.configDir, 'config.json')

  const detector = new MigrationDetector(options.configDir)
  if (detector.needsMigration()) {
    const backup = new BackupManager(options.configDir)
    backup.backupConfig()
    const summary = backup.getBackupSummary()
    console.log(`[MMA] Detected old config. ${summary}`)
    try { unlinkSync(globalPath) } catch { }
  }

  let config: AppConfig = { ...DEFAULTS }

  const globalData = loadJSON(globalPath)
  if (globalData) {
    config = deepMerge(config, globalData as Partial<AppConfig>)
  }

  const projectData = loadJSON(options.projectConfigPath)
  if (projectData) {
    config = deepMerge(config, projectData as Partial<AppConfig>)
  }

  config = applyEnvVars(config)

  return config
}

export function saveConfig(config: AppConfig, configPath: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}
