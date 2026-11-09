// Registry keys for the memory quality gate (spec 2026-11-03-memory-validator-design).
// Kept out of `registry-extra.ts` so the grandfathered ceiling there keeps shrinking.
import { DEFAULTS } from "./defaults";
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";

const DOMAIN = "agent";
const D = DEFAULTS.memory?.validator ?? {
  enabled: true,
  minChars: 15,
  minWords: 3,
  similarityThreshold: 0.8,
};

function def(
  key: string,
  valueType: ConfigKeyDef["valueType"],
  extra: Partial<ConfigKeyDef>,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain: DOMAIN, valueType, effects: [], ...extra, get, set };
}

export const MEMORY_VALIDATOR_DEFS: ConfigKeyDef[] = [
  def("memory.validator", "bool", {},
    (c) => c.memory?.validator?.enabled ?? D.enabled,
    (c, v) => {
      c.memory ??= {};
      c.memory.validator ??= {};
      c.memory.validator.enabled = v as boolean;
    }),
  def("memory.validator.minChars", "int", { min: 5, max: 500, step: 5 },
    (c) => c.memory?.validator?.minChars ?? D.minChars,
    (c, v) => {
      c.memory ??= {};
      c.memory.validator ??= {};
      c.memory.validator.minChars = v as number;
    }),
  def("memory.validator.minWords", "int", { min: 1, max: 20, step: 1 },
    (c) => c.memory?.validator?.minWords ?? D.minWords,
    (c, v) => {
      c.memory ??= {};
      c.memory.validator ??= {};
      c.memory.validator.minWords = v as number;
    }),
  def("memory.validator.similarityThreshold", "share", { min: 0.05, max: 0.9, step: 0.01 },
    (c) => c.memory?.validator?.similarityThreshold ?? D.similarityThreshold,
    (c, v) => {
      c.memory ??= {};
      c.memory.validator ??= {};
      c.memory.validator.similarityThreshold = v as number;
    }),
  def("memory.retentionDays", "int", { min: 0, max: 3650, step: 1 },
    (c) => c.memory?.retentionDays ?? DEFAULTS.memory?.retentionDays ?? 0,
    (c, v) => {
      c.memory ??= {};
      c.memory.retentionDays = v as number;
    }),
];
