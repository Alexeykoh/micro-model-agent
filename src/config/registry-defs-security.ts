// Реестр: тумблеры безопасности (верхнеуровневые и вложенные).
import { DEFAULT_SECURITY_CONFIG } from "./security";
import type { ConfigKeyDef } from "./registry-key-def";

/** Верхнеуровневые + вложенные тумблеры безопасности, все читаются тулами живьём. */
type SecurityToggle = "enabled" | "bash" | "paths" | "contentScan" | "sessionEncryption" | "network";

function securityToggle(field: SecurityToggle, canonical: string): ConfigKeyDef {
  return {
    key: canonical,
    aliases: [],
    domain: "security",
    valueType: "bool",
    // Тулы читают `config.security` живьём; пересборка агента не нужна. Шифрование
    // сессии снапшотится в стор на bootstrap, так что полный эффект — только со
    // следующего запуска: reconfigure его всё равно не пересобрал бы.
    effects: [],
    get: (c) => {
      const sec = c.security;
      if (!sec) return false;
      return field === "enabled" ? sec.enabled : sec[field].enabled;
    },
    set: (c, v) => {
      if (!c.security) c.security = structuredClone(DEFAULT_SECURITY_CONFIG);
      if (field === "enabled") c.security.enabled = v as boolean;
      else c.security[field].enabled = v as boolean;
    },
  };
}

export const SECURITY_DEFS: ConfigKeyDef[] = [
  securityToggle("enabled", "security.enabled"),
  securityToggle("bash", "security.bash.enabled"),
  {
    key: "security.bash.blockDangerousFlags",
    aliases: [],
    domain: "security",
    valueType: "bool",
    effects: [],
    get: (c) => c.security?.bash.blockDangerousFlags ?? true,
    set: (c, v) => {
      if (!c.security) c.security = structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.bash.blockDangerousFlags = v as boolean;
    },
  },
  securityToggle("paths", "security.paths.enabled"),
  securityToggle("contentScan", "security.contentScan.enabled"),
  securityToggle("sessionEncryption", "security.sessionEncryption.enabled"),
  securityToggle("network", "security.network.enabled"),
];
