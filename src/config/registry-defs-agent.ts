// Реестр: ключи агента, бюджета, reasoning, UI, лимитов и критика.
import type { ReasoningMode } from "./types";
import { DEFAULTS } from "./defaults";
import { setBudgetShare, type BudgetShareKey } from "./budget";
import { REBUILD } from "./effects";
import {
  MAX_COMBINED,
  MAX_SHARE,
  MIN_SHARE,
  REASONING_LEVELS,
  VERBOSITY_LEVELS,
  type ConfigKeyDef,
} from "./registry-key-def";

function shareField(key: BudgetShareKey, canonical: string): ConfigKeyDef {
  const field = key === "system" ? "systemPrompt" : "responseReserve";
  const other = key === "system" ? "responseReserve" : "systemPrompt";
  return {
    key: canonical,
    aliases: [`context.${key}`],
    domain: "budget",
    valueType: "share",
    min: MIN_SHARE,
    max: MAX_SHARE,
    step: 0.01,
    effects: REBUILD,
    get: (c) => c.contextBudget[field],
    set: (c, v) => setBudgetShare(c, key, v as number),
    extraValidate: (c, v) => {
      const n = v as number;
      const total = n + c.contextBudget[other];
      return total > MAX_COMBINED ? "combined" : null;
    },
  };
}

export const AGENT_DEFS: ConfigKeyDef[] = [
  {
    key: "model",
    aliases: [],
    domain: "agent",
    valueType: "string",
    effects: REBUILD,
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
    effects: REBUILD,
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
    step: 1024,
    effects: REBUILD,
    get: (c) => c.contextWindow,
    set: (c, v) => {
      c.contextWindow = v as number;
      // Ручное окно = осознанный выбор: проба провайдера больше не перетирает
      // его (boot / смена модели). Обратно — только явный `/config contextAuto true`.
      c.contextAuto = false;
    },
  },
  shareField("system", "contextBudget.systemPrompt"),
  shareField("reserve", "contextBudget.responseReserve"),
  {
    key: "showReasoning",
    aliases: ["reasoning.show"],
    domain: "reasoning",
    valueType: "bool",
    effects: [],
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
    effects: REBUILD,
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
    effects: [],
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
    min: 1, max: 1000, // потолок: иначе `/config maxToolIterations 999999999` снимает лимит итераций хода
    step: 1,
    effects: [],
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
    step: 1,
    effects: [],
    get: (c) => c.stuckThreshold,
    set: (c, v) => {
      c.stuckThreshold = v as number;
    },
  },
  {
    key: "critic.enabled",
    aliases: [],
    domain: "agent",
    valueType: "bool",
    effects: REBUILD,
    get: (c) => c.critic?.enabled ?? DEFAULTS.critic.enabled,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), enabled: v as boolean };
    },
  },
  {
    key: "critic.maxCalls",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 0,
    max: 20,
    step: 1,
    effects: REBUILD,
    get: (c) => c.critic?.maxCalls ?? DEFAULTS.critic.maxCalls,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), maxCalls: v as number };
    },
  },
  {
    key: "critic.maxRepairCycles",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 0,
    max: 5,
    step: 1,
    effects: REBUILD,
    get: (c) => c.critic?.maxRepairCycles ?? DEFAULTS.critic.maxRepairCycles,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), maxRepairCycles: v as number };
    },
  },
  {
    key: "critic.timeoutMs",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 1000,
    max: 300000,
    step: 1000,
    effects: REBUILD,
    get: (c) => c.critic?.timeoutMs ?? DEFAULTS.critic.timeoutMs,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), timeoutMs: v as number };
    },
  },
  {
    key: "critic.model",
    aliases: [],
    domain: "agent",
    valueType: "string",
    effects: REBUILD,
    allowEmpty: true,
    editor: { kind: "select", optionsSource: "models" },
    get: (c) => c.critic?.model ?? "",
    set: (c, v) => {
      const s = String(v).trim();
      c.critic = { ...(c.critic ?? DEFAULTS.critic), model: s ? s : undefined };
    },
  },
  {
    key: "critic.tools",
    aliases: [],
    domain: "agent",
    valueType: "bool",
    effects: REBUILD,
    get: (c) => c.critic?.tools ?? DEFAULTS.critic.tools,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), tools: v as boolean };
    },
  },
  {
    key: "critic.provider",
    aliases: [],
    domain: "agent",
    valueType: "string",
    effects: REBUILD,
    allowEmpty: true,
    editor: { kind: "select", optionsSource: "providers" },
    get: (c) => {
      const p = c.critic?.provider;
      if (!p) return "";
      if (typeof p === "string") return p;
      return p.active ?? p.type ?? "";
    },
    set: (c, v) => {
      const s = String(v).trim();
      c.critic = {
        ...(c.critic ?? DEFAULTS.critic),
        provider: s ? s : undefined,
      };
    },
    extraValidate: (c, v) => {
      const s = String(v).trim();
      if (!s) return null;
      const entries = c.provider.entries ?? [];
      if (entries.length === 0) return null;
      const found = entries.some((e) => (e.label || e.type) === s || e.type === s);
      return found ? null : "invalid";
    },
  },
  {
    key: "critic.maxTokens",
    aliases: [],
    domain: "agent",
    valueType: "int",
    min: 256,
    max: 32768,
    step: 256,
    effects: REBUILD,
    get: (c) => c.critic?.maxTokens ?? DEFAULTS.critic.maxTokens,
    set: (c, v) => {
      c.critic = { ...(c.critic ?? DEFAULTS.critic), maxTokens: v as number };
    },
  },
];
