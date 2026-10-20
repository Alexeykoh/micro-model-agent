// Дефы корпоративного слоя DLP (`security.dataPolicy.*`, спека 2026-10-19).
// Отдельный модуль, чтобы `registry-extra.ts` не разрастался (правило 6).
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { REBUILD } from "./effects";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { DEFAULT_DATA_POLICY } from "../modules/security/data-policy/defaults";
import type { DataPolicyConfig } from "../modules/security/data-policy/types";

/** Лениво создаёт гнездо security и возвращает его. */
function sec(c: AppConfig) {
  c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
  return c.security;
}

/** Лениво создаёт гнездо dataPolicy внутри security и возвращает его. */
function dp(c: AppConfig): DataPolicyConfig {
  const s = sec(c);
  s.dataPolicy ??= structuredClone(DEFAULT_DATA_POLICY);
  return s.dataPolicy;
}

/** bool-деф `security.dataPolicy.<key>` (влияет на сборку провайдера). */
function dpBool(
  key: string,
  pick: (d: DataPolicyConfig) => boolean,
  put: (d: DataPolicyConfig, v: boolean) => void,
): ConfigKeyDef {
  return {
    key: `security.dataPolicy.${key}`,
    aliases: [],
    domain: "security",
    valueType: "bool",
    effects: REBUILD,
    get: (c) => pick(dp(c)),
    set: (c, v) => put(dp(c), v as boolean),
  };
}

/**
 * list-деф `security.dataPolicy.<key>`. Эффект — пересборка: и allowlist
 * доверенных хостов, и glob-списки читаются при сборке провайдера, поэтому
 * правка из UI обязана дойти до живого guard'а, а не ждать рестарта.
 */
function dpList(
  key: string,
  pick: (d: DataPolicyConfig) => string[],
  put: (d: DataPolicyConfig, v: string[]) => void,
  placeholder: string,
): ConfigKeyDef {
  return {
    key: `security.dataPolicy.${key}`,
    aliases: [],
    domain: "security",
    valueType: "list",
    effects: REBUILD,
    editor: { kind: "tags", placeholder },
    get: (c) => pick(dp(c)),
    set: (c, v) => put(dp(c), v as string[]),
  };
}

/** Дефы слоя DLP. */
export const DATA_POLICY_DEFS: ConfigKeyDef[] = [
  dpBool("enabled", (d) => d.enabled, (d, v) => { d.enabled = v; }),
  dpBool("trustLocalClients", (d) => d.trustLocalClients, (d, v) => { d.trustLocalClients = v; }),
  {
    key: "security.dataPolicy.pathMode",
    aliases: [],
    domain: "security",
    valueType: "enum",
    enumValues: ["prefix", "full"],
    effects: REBUILD,
    get: (c) => c.security?.dataPolicy?.pathMode ?? DEFAULT_DATA_POLICY.pathMode,
    set: (c, v) => { dp(c).pathMode = v as "prefix" | "full"; },
  },
  dpBool("pseudonymize", (d) => d.pseudonymize, (d, v) => { d.pseudonymize = v; }),
  dpBool("egress.paths", (d) => d.egress.paths, (d, v) => { d.egress.paths = v; }),
  dpBool("egress.machine", (d) => d.egress.machine, (d, v) => { d.egress.machine = v; }),
  dpBool("egress.env", (d) => d.egress.env, (d, v) => { d.egress.env = v; }),
  dpBool("egress.pii", (d) => d.egress.pii, (d, v) => { d.egress.pii = v; }),
  dpBool("egress.fileContent", (d) => d.egress.fileContent, (d, v) => { d.egress.fileContent = v; }),
  dpBool("allowImagesToExternal", (d) => d.allowImagesToExternal, (d, v) => { d.allowImagesToExternal = v; }),
  dpBool("failClosed", (d) => d.failClosed, (d, v) => { d.failClosed = v; }),
  {
    key: "security.dataPolicy.minConfidence",
    aliases: [],
    domain: "security",
    valueType: "share",
    min: 0.05,
    max: 0.9,
    step: 0.01,
    effects: REBUILD,
    get: (c) => c.security?.dataPolicy?.minConfidence ?? DEFAULT_DATA_POLICY.minConfidence,
    set: (c, v) => { dp(c).minConfidence = v as number; },
  },
  dpList("trustedHosts", (d) => d.trustedHosts, (d, v) => { d.trustedHosts = v; }, "ollama.corp"),
  dpList("apiHiddenGlobs", (d) => d.apiHiddenGlobs, (d, v) => { d.apiHiddenGlobs = v; }, "private/**"),
  dpList("providerBlockGlobs", (d) => d.providerBlockGlobs, (d, v) => { d.providerBlockGlobs = v; }, "*.key"),
];
