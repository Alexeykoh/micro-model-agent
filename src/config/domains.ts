import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { AppConfig } from "./types";

/**
 * Mapping: domain name → AppConfig keys that belong to it.
 * Each domain becomes one JSON file in ~/.mma/config/<domain>.json.
 */
export const CONFIG_DOMAINS: Record<string, (keyof AppConfig)[]> = {
  core: [
    "version",
    "model",
    "contextWindow",
    "contextBudget",
    "modelLoad",
    "maxToolIterations",
    "stuckThreshold",
    "autoPlan",
    "showReasoning",
    "logLevel",
    "locale",
  ],
  provider: ["provider", "orchestrator", "retry", "pricing"],
  moe: ["moe", "experts"],
  security: ["security"],
  browser: ["browser"],
  search: ["webSearch", "errorWebSearch"],
  tools: ["tools", "subagent"],
  session: ["session", "sessionIsolation"],
  ui: ["ui"],
  mcp: ["mcpServers"],
  lsp: ["lsp"],
  skills: ["skills"],
  updater: ["updater"],
};

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

/**
 * Deep merge two objects. Arrays and scalars in source replace target.
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = { ...(target as any) };
  for (const key of Object.keys(source as object)) {
    const srcVal = (source as any)[key];
    const tgtVal = (target as any)[key];
    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result as T;
}

/**
 * Extract a domain subset from a full AppConfig.
 */
export function extractDomain(
  config: AppConfig,
  domain: string,
): Record<string, unknown> {
  const keys = CONFIG_DOMAINS[domain];
  if (!keys) return {};
  const subset: Record<string, unknown> = {};
  for (const key of keys) {
    if ((config as any)[key] !== undefined) {
      subset[key] = (config as any)[key];
    }
  }
  return subset;
}

/**
 * Get the file path for a domain config file.
 */
export function getDomainFilePath(configDir: string, domain: string): string {
  return join(configDir, "config", `${domain}.json`);
}

/**
 * Check if domain files exist in config/ directory.
 */
export function hasDomainFiles(configDir: string): boolean {
  const configDirPath = join(configDir, "config");
  if (!existsSync(configDirPath)) return false;
  try {
    const files = readdirSync(configDirPath);
    return files.some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * Load all domain files from ~/.mma/config/ and merge into a partial AppConfig.
 * Each file is parsed with regexReviver to restore RegExp objects.
 * Returns null if no domain files exist.
 */
export function loadDomainFiles(
  configDir: string,
): Partial<AppConfig> | null {
  const configDirPath = join(configDir, "config");
  if (!existsSync(configDirPath)) return null;

  let result: Record<string, unknown> = {};
  let anyLoaded = false;

  for (const domain of Object.keys(CONFIG_DOMAINS)) {
    const filePath = getDomainFilePath(configDir, domain);
    if (!existsSync(filePath)) continue;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw, regexReviver as (key: string, value: unknown) => unknown);
      result = deepMerge(result, data);
      anyLoaded = true;
    } catch {
      // Skip malformed domain files
    }
  }

  return anyLoaded ? (result as Partial<AppConfig>) : null;
}

/**
 * Save a full AppConfig to domain files in ~/.mma/config/.
 * Each domain's keys are extracted and written to config/<domain>.json.
 * RegExp objects are serialized via regexReplacer.
 */
export function saveDomainFiles(
  config: AppConfig,
  configDir: string,
): void {
  const configDirPath = join(configDir, "config");
  mkdirSync(configDirPath, { recursive: true });

  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    const subset: Record<string, unknown> = {};
    let hasContent = false;
    for (const key of keys) {
      if ((config as any)[key] !== undefined) {
        subset[key] = (config as any)[key];
        hasContent = true;
      }
    }
    if (!hasContent) continue;

    const filePath = getDomainFilePath(configDir, domain);
    writeFileSync(
      filePath,
      JSON.stringify(subset, regexReplacer, 2),
      "utf-8",
    );
  }
}

/**
 * Determine which domain a config key belongs to.
 * Returns the domain name or null if not found.
 */
export function domainForKey(key: string): string | null {
  for (const [domain, keys] of Object.entries(CONFIG_DOMAINS)) {
    if ((keys as string[]).includes(key)) return domain;
  }
  return null;
}
