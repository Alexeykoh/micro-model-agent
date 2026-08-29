import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { DEFAULTS } from "./defaults";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { t } from "../i18n/index";
import type { AppConfig, ProviderEntry } from "./types";
import { MigrationDetector } from "../migration/detect";
import { BackupManager } from "../migration/backup";
import { validateExpertConfig } from "./experts";
import { ConfigEncryptor } from "../modules/security/encryption";
import { loadDomainFiles, saveDomainFiles, hasDomainFiles } from "./domains";

// ── Centralized path constants ──────────────────────────────────────────
export const CONFIG_DIR = join(homedir(), ".mma");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const CONFIG_DOMAIN_DIR = join(CONFIG_DIR, "config");

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Restore RegExp instances in dangerousPatterns that were serialized as {}
 * (pre-0.8.0 configs) or as {__regex, source, flags} (new format).
 * Falls back to default patterns for any entry that is not a real RegExp.
 */
function restoreDangerousPatterns(patterns: unknown, defaults: unknown): RegExp[] {
  const fallback = (Array.isArray(defaults) ? defaults : []) as RegExp[];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return fallback;
  }
  return patterns.map((p, i) => {
    if (p instanceof RegExp) return p;
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
    return fallback[i] || fallback[0] || (p as RegExp);
  });
}

function isPlainObject(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function deepMerge<T>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = { ...(target as any) };
  for (const key of Object.keys(source as object)) {
    const srcVal = (source as any)[key];
    const tgtVal = (target as any)[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      // Assign non-plain values (RegExp, Date, arrays, primitives) by
      // reference — spreading a RegExp would silently destroy it to {}.
      result[key] = srcVal;
    }
  }
  return result as T;
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
  if (value && typeof value === "object" && (value as Record<string, unknown>).__regex === true) {
    const { source, flags } = value as { source: string; flags: string };
    try {
      return new RegExp(source, flags);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Legacy npx `args` for LSP servers that predate the fixed invocation.
 */
const LEGACY_LSP_SERVER_ARGS: Record<string, { args: string[]; timeout: number }> = {
  typescript: { args: ["typescript-language-server", "--stdio"], timeout: 30000 },
  javascript: { args: ["typescript-language-server", "--stdio"], timeout: 30000 },
  json: { args: ["vscode-json-languageserver", "--stdio"], timeout: 30000 },
  html: { args: ["vscode-html-languageserver", "--stdio"], timeout: 60000 },
  css: { args: ["vscode-css-languageserver", "--stdio"], timeout: 60000 },
};

/**
 * Replace stale pre-0.41.1 LSP server invocations with current defaults.
 */
function normalizeLspServerArgs(config: AppConfig): void {
  const servers = config.lsp?.servers;
  if (!servers) return;
  for (const [lang, legacy] of Object.entries(LEGACY_LSP_SERVER_ARGS)) {
    const server = servers[lang];
    const def = DEFAULT_LSP_CONFIG.servers[lang];
    if (!server || server.command !== "npx" || !def) continue;
    const storedArgs = Array.isArray(server.args) ? server.args : null;
    const isLegacy = storedArgs === null || JSON.stringify(storedArgs) === JSON.stringify(legacy.args);
    if (isLegacy) {
      server.args = def.args;
      server.timeout = def.timeout;
    }
  }
}

function loadJSON(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(
      readFileSync(path, "utf-8"),
      regexReviver as (key: string, value: unknown) => unknown,
    ) as Record<string, unknown>;
  } catch {
    // Never silent: a typo'd config must not quietly wipe the user's settings.
    console.warn(t("config.parse_failed", { path }));
  }
  return null;
}

interface EnvOverride {
  key: string;
  envValue: unknown;
  originalValue: unknown;
}

/**
 * Apply MMA_* env overrides. Returns the overridden keys with their PRE-ENV
 * values so `saveConfig` can avoid persisting session-scoped env values (C4).
 */
function applyEnvVars(config: AppConfig): { config: AppConfig; overrides: EnvOverride[] } {
  const env = process.env;
  const overrides: EnvOverride[] = [];
  const result = { ...config };

  const record = (key: string, envValue: unknown): void => {
    const original = (result as any)[key];
    if (original !== envValue) overrides.push({ key, envValue, originalValue: original });
  };

  if (env.MMA_MODEL) {
    record("model", env.MMA_MODEL);
    result.model = env.MMA_MODEL;
  }

  const originalProvider = result.provider;

  // normalizeEntries prefers entries[] and ignores the flat provider fields, so
  // a flat-only env override is a silent no-op on multi-provider configs (the
  // certification harness depends on these vars working). Resolve the active
  // entry and patch it too.
  const activeEntryIndex = ((): number => {
    const entries = result.provider.entries;
    if (!entries || entries.length === 0) return -1;
    const active = result.provider.active;
    if (!active) return 0;
    const i = entries.findIndex((e) => e.label === active || e.type === active);
    return i >= 0 ? i : 0;
  })();

  const patchActiveEntry = (patch: Partial<ProviderEntry>): void => {
    if (activeEntryIndex < 0) return;
    const entries = result.provider.entries!;
    const next = [...entries];
    next[activeEntryIndex] = { ...next[activeEntryIndex], ...patch };
    result.provider = { ...result.provider, entries: next };
  };

  if (env.MMA_PROVIDER_TYPE) {
    result.provider = { ...result.provider, type: env.MMA_PROVIDER_TYPE };
    patchActiveEntry({ type: env.MMA_PROVIDER_TYPE });
  }
  if (env.MMA_PROVIDER_BASEURL) {
    result.provider = { ...result.provider, baseUrl: env.MMA_PROVIDER_BASEURL };
    patchActiveEntry({ baseUrl: env.MMA_PROVIDER_BASEURL });
  }
  if (env.MMA_PROVIDER_APIKEY) {
    result.provider = { ...result.provider, apiKey: env.MMA_PROVIDER_APIKEY };
    patchActiveEntry({ apiKey: env.MMA_PROVIDER_APIKEY });
  }
  if (env.MMA_PROVIDER_TYPE || env.MMA_PROVIDER_BASEURL || env.MMA_PROVIDER_APIKEY) {
    // Record once with the FINAL env-mutated provider object so the identity
    // check in stripEnvOverrides matches what the loaded config holds.
    overrides.push({ key: "provider", envValue: result.provider, originalValue: originalProvider });
  }
  if (env.MMA_LOG_LEVEL) {
    record("logLevel", env.MMA_LOG_LEVEL);
    result.logLevel = env.MMA_LOG_LEVEL;
  }
  if (env.MMA_LOCALE) {
    record("locale", env.MMA_LOCALE);
    result.locale = env.MMA_LOCALE;
  }
  if (env.MMA_CONTEXT_WINDOW) {
    const v = parseInt(env.MMA_CONTEXT_WINDOW, 10);
    if (!isNaN(v)) {
      record("contextWindow", v);
      result.contextWindow = v;
    }
  }
  if (env.MMA_MAX_TOOL_ITERATIONS) {
    const v = parseInt(env.MMA_MAX_TOOL_ITERATIONS, 10);
    if (!isNaN(v)) {
      record("maxToolIterations", v);
      result.maxToolIterations = v;
    }
  }
  if (env.MMA_STUCK_THRESHOLD) {
    const v = parseInt(env.MMA_STUCK_THRESHOLD, 10);
    if (!isNaN(v)) {
      record("stuckThreshold", v);
      result.stuckThreshold = v;
    }
  }
  if (env.MMA_AUTO_PLAN) {
    const v = env.MMA_AUTO_PLAN === "true";
    record("autoPlan", v);
    result.autoPlan = v;
  }
  if (env.MMA_MOE_ENABLED) {
    const next = { ...result.moe, enabled: env.MMA_MOE_ENABLED === "true" };
    record("moe", next);
    result.moe = next;
  }

  return { config: result, overrides };
}

/** Pre-env values for env-touched keys, keyed by the loaded config object. */
const envOverrideMap = new WeakMap<AppConfig, EnvOverride[]>();

/**
 * Restore pre-env values before persisting — session-scoped env overrides
 * (e.g. the cert harness baseUrl) must NOT leak into domain files. An explicit
 * later change (setProvider/reconfigure replacing provider, /model use) shows
 * up as a different object/value and is kept as-is.
 */
function stripEnvOverrides(config: AppConfig): AppConfig {
  const overrides = envOverrideMap.get(config);
  if (!overrides || overrides.length === 0) return config;
  const result = { ...config };
  for (const o of overrides) {
    if ((result as any)[o.key] === o.envValue) {
      (result as any)[o.key] = o.originalValue;
    }
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  configDir: string;
  projectConfigPath: string;
}

export interface LoadConfigResult {
  config: AppConfig;
  /** true when a legacy config.json was used (no domain files found). */
  legacyDetected: boolean;
}

/**
 * Load config from domain files (preferred) or legacy config.json (fallback).
 *
 * Pipeline:
 *   1. DEFAULTS
 *   2. deepMerge(legacy config.json)  — if exists
 *   3. deepMerge(domain files)        — if exist, override legacy
 *   4. deepMerge(project .mmrc)       — overrides everything
 *   5. Post-load fixups (RegExp, LSP args)
 *   6. Env vars
 *   7. Decrypt
 *
 * On first run (no config.json, no domain files), auto-creates domain files.
 */
export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const globalPath = join(options.configDir, "config.json");

  mkdirSync(options.configDir, { recursive: true });

  // v1 → v2 migration check (reads config.json directly, before domain logic)
  const detector = new MigrationDetector(options.configDir);
  if (detector.needsMigration()) {
    const backup = new BackupManager(options.configDir);
    // Full-directory backup (documented behavior) + config.json snapshot
    // before we touch anything.
    backup.backupAll();
    backup.backupConfig();
    const summary = backup.getBackupSummary();
    console.log(t("migration.detected", { summary }));
    try {
      unlinkSync(globalPath);
    } catch (e) {
      // Best-effort removal: loadConfig falls back to defaults either way,
      // but a leftover v1 file would re-trigger migration on every startup.
      console.error("[config] failed to remove legacy config.json:", e);
    }
  }

  // Deep clone: DEFAULTS holds singleton objects (security, lsp, tools…)
  // that must never be mutated by runtime config changes.
  let config: AppConfig = structuredClone(DEFAULTS);
  let legacyDetected = false;

  // Step 1: legacy config.json (fallback)
  const globalData = loadJSON(globalPath);
  if (globalData) {
    config = deepMerge(config, globalData as Partial<AppConfig>);
    legacyDetected = true;
  }

  // Step 2: domain files (override legacy)
  const domainConfig = loadDomainFiles(options.configDir);
  if (domainConfig) {
    config = deepMerge(config, domainConfig);
    legacyDetected = false;
  }

  // Step 3: first run — auto-create domain files instead of config.json
  if (!globalData && !domainConfig) {
    saveDomainFiles(config, options.configDir);
  }

  // Step 4: project .mmrc (overrides everything)
  const projectData = loadJSON(options.projectConfigPath);
  if (projectData) {
    config = deepMerge(config, projectData as Partial<AppConfig>);
  }

  // Step 5: post-load fixups — AFTER all merges
  if (config.security?.contentScan?.dangerousPatterns) {
    config.security.contentScan.dangerousPatterns = restoreDangerousPatterns(
      config.security.contentScan.dangerousPatterns,
      DEFAULT_SECURITY_CONFIG.contentScan.dangerousPatterns,
    );
  }
  normalizeLspServerArgs(config);

  // Step 6: env vars
  const { config: envConfig, overrides } = applyEnvVars(config);
  config = envConfig;

  // Step 7: decrypt
  try {
    const encryptor = new ConfigEncryptor();
    const decrypted = encryptor.decrypt(config as unknown as Record<string, unknown>);
    for (const key of Object.keys(decrypted)) {
      (config as any)[key] = decrypted[key];
    }
    // Decrypt rebuilds the object tree (new identities). Re-point the provider
    // override at the post-decrypt provider so the save-time identity check in
    // stripEnvOverrides still matches the loaded config.
    const providerOverride = overrides.find((o) => o.key === "provider");
    if (providerOverride) providerOverride.envValue = (config as any).provider;
  } catch (e: any) {
    console.warn(t("config.decryption_warning", { error: e.message }));
  }

  if (overrides.length > 0) envOverrideMap.set(config, overrides);

  return { config, legacyDetected };
}

export function validateConfig(config: AppConfig, allToolTags: string[]): void {
  const errors = validateExpertConfig(config, allToolTags);
  const knownTags = new Set(allToolTags);
  for (const tag of config.tools?.defaultTags ?? []) {
    if (!knownTags.has(tag)) {
      errors.push(
        `tools.defaultTags references unknown tag "${tag}". Known tags: ${Array.from(knownTags).join(", ")}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n${errors.join("\n")}`);
  }
}

/**
 * Save config to domain files (preferred) or legacy single file (fallback).
 *
 * @param config   Full AppConfig to save
 * @param configPath  Legacy path (e.g. ~/.mma/config.json) — used when configDir is absent
 * @param configDir  Optional config directory (e.g. ~/.mma). When provided, writes domain files.
 */
export function saveConfig(config: AppConfig, configPath: string, configDir?: string): void {
  // Session-scoped MMA_* env overrides must not be persisted (C4).
  const toWrite = stripEnvOverrides(config);
  if (configDir) {
    saveDomainFiles(toWrite, configDir);
    return;
  }

  // Legacy single-file write (backward compat for tests / edge cases)
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });

  try {
    const encryptor = new ConfigEncryptor();
    const encryptedConfig = encryptor.encrypt({
      ...toWrite,
    } as unknown as Record<string, unknown>);
    writeFileSync(configPath, JSON.stringify(encryptedConfig, regexReplacer, 2), "utf-8");
  } catch (e: any) {
    console.warn(t("config.encryption_warning", { error: e.message }));
    writeFileSync(configPath, JSON.stringify(toWrite, regexReplacer, 2), "utf-8");
  }
}
