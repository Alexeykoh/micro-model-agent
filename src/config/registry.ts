import type { AppConfig, ReasoningMode } from "./types";
import { DEFAULTS } from "./defaults";
import { setBudgetShare, type BudgetShareKey } from "./budget";

/**
 * Central registry of user-facing config keys for `/config` and the sugar
 * commands. Canonical keys are literal `config.json` paths so that what the
 * user reads in the file is what they type; short aliases are accepted for
 * convenience but never produce a second entry in the dump. This module owns
 * resolution + parsing + validation only — persistence and `reconfigure` are
 * the caller's job (`repl-commands.mutateConfig`), keeping one write path.
 */

export type ConfigValueType = "string" | "int" | "share" | "bool" | "enum";

export const REASONING_LEVELS = [
  "auto",
  "default",
  "none",
  "low",
  "medium",
  "high",
  "max",
] as const;

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

export const VERBOSITY_LEVELS = ["quiet", "normal", "verbose"] as const;

export const LOCALES = ["en", "ru"] as const;

export type ConfigErrorReason = "unknown-key" | "read-only" | "invalid-value";
export type ConfigRangeReason = "range" | "combined";

export interface ConfigKeyDef {
  /** Canonical key — literal config.json path. */
  key: string;
  aliases: string[];
  domain: string;
  valueType: ConfigValueType;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  reconfigure: boolean;
  readOnly?: boolean;
  get(config: AppConfig): unknown;
  set?(config: AppConfig, value: unknown): void;
  /** Extra validation beyond type/range (e.g. provider entry existence). */
  extraValidate?(config: AppConfig, value: unknown): ConfigRangeReason | "invalid" | null;
}

const MIN_SHARE = 0.05;
const MAX_SHARE = 0.9;
const MAX_COMBINED = 0.95;

function shareField(key: BudgetShareKey, canonical: string): ConfigKeyDef {
  const field = key === "system" ? "systemPrompt" : "responseReserve";
  const other = key === "system" ? "responseReserve" : "systemPrompt";
  return {
    key: canonical,
    aliases: [`context.${key}`],
    domain: "budget",
    valueType: "share",
    reconfigure: true,
    get: (c) => c.contextBudget[field],
    set: (c, v) => setBudgetShare(c, key, v as number),
    extraValidate: (c, v) => {
      const n = v as number;
      const total = n + c.contextBudget[other];
      return total > MAX_COMBINED ? "combined" : null;
    },
  };
}

const DEFINITIONS: ConfigKeyDef[] = [
  {
    key: "model",
    aliases: [],
    domain: "agent",
    valueType: "string",
    reconfigure: true,
    get: (c) => c.model,
    set: (c, v) => {
      c.model = String(v);
    },
  },
  {
    key: "provider.active",
    aliases: [],
    domain: "provider",
    valueType: "string",
    reconfigure: true,
    get: (c) => c.provider.active ?? c.provider.type,
    set: (c, v) => {
      c.provider.active = String(v);
    },
    extraValidate: (c, v) => {
      const entries = c.provider.entries ?? [];
      if (entries.length === 0) return null;
      const name = String(v);
      const found = entries.some((e) => e.label === name || e.type === name);
      return found ? null : "invalid";
    },
  },
  {
    key: "contextWindow",
    aliases: ["context.window"],
    domain: "budget",
    valueType: "int",
    min: 1024,
    reconfigure: true,
    get: (c) => c.contextWindow,
    set: (c, v) => {
      c.contextWindow = v as number;
    },
  },
  shareField("system", "contextBudget.systemPrompt"),
  shareField("reserve", "contextBudget.responseReserve"),
  {
    key: "showReasoning",
    aliases: ["reasoning.show"],
    domain: "reasoning",
    valueType: "bool",
    reconfigure: false,
    get: (c) => c.showReasoning,
    set: (c, v) => {
      c.showReasoning = v as boolean;
    },
  },
  {
    key: "reasoning.mode",
    aliases: ["reasoning.level"],
    domain: "reasoning",
    valueType: "enum",
    enumValues: REASONING_LEVELS,
    reconfigure: true,
    get: (c) => c.reasoning?.mode ?? "auto",
    set: (c, v) => {
      const base = c.reasoning ?? structuredClone(DEFAULTS.reasoning!);
      c.reasoning = { ...base, mode: v as ReasoningMode };
    },
  },
  {
    key: "ui.verbosity",
    aliases: ["verbosity"],
    domain: "ui",
    valueType: "enum",
    enumValues: VERBOSITY_LEVELS,
    reconfigure: false,
    get: (c) => c.ui.verbosity ?? (c.ui.verbose ? "verbose" : "quiet"),
    set: (c, v) => {
      c.ui.verbosity = v as "quiet" | "normal" | "verbose";
    },
  },
  {
    key: "maxToolIterations",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 1,
    reconfigure: false,
    get: (c) => c.maxToolIterations,
    set: (c, v) => {
      c.maxToolIterations = v as number;
    },
  },
  {
    key: "stuckThreshold",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 1,
    reconfigure: false,
    get: (c) => c.stuckThreshold,
    set: (c, v) => {
      c.stuckThreshold = v as number;
    },
  },
  {
    key: "logLevel",
    aliases: [],
    domain: "agent",
    valueType: "enum",
    enumValues: LOG_LEVELS,
    reconfigure: false,
    get: (c) => c.logLevel,
    set: (c, v) => {
      c.logLevel = String(v);
    },
  },
  {
    key: "locale",
    aliases: [],
    domain: "i18n",
    valueType: "enum",
    enumValues: LOCALES,
    reconfigure: false,
    get: (c) => c.locale,
    set: (c, v) => {
      c.locale = String(v);
    },
  },
  {
    key: "version",
    aliases: [],
    domain: "agent",
    valueType: "string",
    reconfigure: false,
    readOnly: true,
    get: (c) => c.version,
  },
];

const BY_NAME = new Map<string, ConfigKeyDef>();
for (const def of DEFINITIONS) {
  BY_NAME.set(def.key, def);
  for (const alias of def.aliases) BY_NAME.set(alias, def);
}

export function resolveConfigKey(name: string): ConfigKeyDef | null {
  return BY_NAME.get(name) ?? null;
}

export function configDefs(): readonly ConfigKeyDef[] {
  return DEFINITIONS;
}

/** All canonical keys (for the dump), in registry order. */
export function canonicalKeys(): string[] {
  return DEFINITIONS.map((d) => d.key);
}

/**
 * Keys in a canonical group prefix (e.g. "contextBudget" → systemPrompt,
 * responseReserve). Matches `prefix.` exactly, so `/config contextBudget`
 * lists both shares.
 */
export function keysForGroup(prefix: string): ConfigKeyDef[] {
  return DEFINITIONS.filter((d) => d.key.startsWith(prefix + "."));
}

/** Canonical + alias names, for completion. */
export function allConfigNames(): Array<{ name: string; def: ConfigKeyDef; alias: boolean }> {
  const out: Array<{ name: string; def: ConfigKeyDef; alias: boolean }> = [];
  for (const def of DEFINITIONS) {
    out.push({ name: def.key, def, alias: false });
    for (const a of def.aliases) out.push({ name: a, def, alias: true });
  }
  return out;
}

export function formatConfigValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; reason: "invalid" };

function parseBool(raw: string): ParseResult {
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes", "y", "enable", "enabled"].includes(v)) return { ok: true, value: true };
  if (["off", "false", "0", "no", "n", "disable", "disabled"].includes(v)) return { ok: true, value: false };
  return { ok: false, reason: "invalid" };
}

export function parseConfigValue(def: ConfigKeyDef, raw: string): ParseResult {
  const trimmed = raw.trim();
  switch (def.valueType) {
    case "string":
      return trimmed.length > 0 ? { ok: true, value: trimmed } : { ok: false, reason: "invalid" };
    case "bool":
      return parseBool(trimmed);
    case "enum": {
      const v = trimmed.toLowerCase();
      if (def.enumValues && !def.enumValues.includes(v)) return { ok: false, reason: "invalid" };
      return { ok: true, value: v };
    }
    case "int": {
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, reason: "invalid" };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid" };
      if (def.min !== undefined && n < def.min) return { ok: false, reason: "invalid" };
      if (def.max !== undefined && n > def.max) return { ok: false, reason: "invalid" };
      return { ok: true, value: n };
    }
    case "share": {
      // Accept a fraction (0.1) or a percentage (10%).
      const isPct = trimmed.endsWith("%");
      const body = isPct ? trimmed.slice(0, -1).trim() : trimmed;
      if (!/^-?\d+(\.\d+)?$/.test(body)) return { ok: false, reason: "invalid" };
      let n = Number(body);
      if (isPct) n = n / 100;
      if (!Number.isFinite(n) || n < MIN_SHARE || n > MAX_SHARE) return { ok: false, reason: "invalid" };
      return { ok: true, value: n };
    }
  }
}

export interface ConfigGetOk {
  ok: true;
  key: string;
  def: ConfigKeyDef;
  value: unknown;
  display: string;
}
export interface ConfigError {
  ok: false;
  reason: ConfigErrorReason;
  input: string;
}
export type ConfigGetResult = ConfigGetOk | ConfigError;

export function getConfigValue(config: AppConfig, name: string): ConfigGetResult {
  const def = resolveConfigKey(name);
  if (!def) return { ok: false, reason: "unknown-key", input: name };
  const value = def.get(config);
  return { ok: true, key: def.key, def, value, display: formatConfigValue(value) };
}

export interface ConfigSetOk {
  ok: true;
  key: string;
  def: ConfigKeyDef;
  value: unknown;
  display: string;
  reconfigure: boolean;
  /** Key needs an agent-level reasoning side effect after apply. */
  reasoningChanged: boolean;
}
export interface ConfigSetErrorFail {
  ok: false;
  reason: ConfigErrorReason | ConfigRangeReason | "invalid";
  input: string;
  key?: string;
  def?: ConfigKeyDef;
}
export type ConfigSetResult = ConfigSetOk | ConfigSetErrorFail;

export function setConfigValue(config: AppConfig, name: string, raw: string): ConfigSetResult {
  const def = resolveConfigKey(name);
  if (!def) return { ok: false, reason: "unknown-key", input: name };
  if (def.readOnly) return { ok: false, reason: "read-only", input: name, key: def.key, def };

  const parsed = parseConfigValue(def, raw);
  if (!parsed.ok) return { ok: false, reason: "invalid-value", input: name, key: def.key, def };

  const extra = def.extraValidate?.(config, parsed.value);
  if (extra) return { ok: false, reason: extra, input: name, key: def.key, def };

  def.set!(config, parsed.value);
  return {
    ok: true,
    key: def.key,
    def,
    value: parsed.value,
    display: formatConfigValue(parsed.value),
    reconfigure: def.reconfigure,
    reasoningChanged: def.key === "reasoning.mode",
  };
}

export function isKnownConfigKey(name: string): boolean {
  return BY_NAME.has(name);
}

/**
 * Capture the current value of every canonical key. Used at REPL start as the
 * "boot snapshot" so `/config reset` can undo changes made during the session
 * (rather than jumping to schema defaults, which are ambiguous for fields like
 * `provider.active`).
 */
export function captureConfigSnapshot(config: AppConfig): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const def of DEFINITIONS) {
    try {
      snapshot.set(def.key, structuredClone(def.get(config)));
    } catch {
      // Partial/mock configs (tests) may lack a field — skip it, not the whole
      // snapshot. Real configs are complete.
    }
  }
  return snapshot;
}
