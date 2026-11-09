// Доп. дефы реестра (~110 ключей): сборка `EXTRA_DEFS` из групп
// `registry-extra-*.ts` (правило 6) + канонические типы аудит-событий.
// Фабрики bool/int/share/enum/list/str/json — в `registry-extra-factories.ts`.
import type { ConfigKeyDef } from "./registry";
import { DATA_POLICY_DEFS } from "./registry-data-policy";
import { SERVICE_DEFS } from "./registry-service";
import { SOUND_DEFS } from "./registry-sounds";
import { MEMORY_VALIDATOR_DEFS } from "./registry-memory";
import { EXECUTION_DEFS } from "./registry-execution";
import { PROVIDER_EXTRA_DEFS } from "./registry-extra-provider";
import { AGENT_EXTRA_DEFS } from "./registry-extra-agent";
import { FEATURE_DEFS } from "./registry-extra-features";
import { SECURITY_EXTRA_DEFS } from "./registry-extra-security";
import { CAPABILITY_DEFS } from "./registry-extra-capabilities";

export { AUDIT_EVENT_TYPES } from "./registry-extra-security";

/** Доп. дефы реестра; мержится в DEFINITIONS конкатом (см. registry.ts). */
export const EXTRA_DEFS: ConfigKeyDef[] = [
  ...DATA_POLICY_DEFS,
  ...SOUND_DEFS,
  ...MEMORY_VALIDATOR_DEFS,
  ...EXECUTION_DEFS,
  ...PROVIDER_EXTRA_DEFS,
  ...AGENT_EXTRA_DEFS,
  ...FEATURE_DEFS,
  ...SECURITY_EXTRA_DEFS,
  ...CAPABILITY_DEFS,
  ...SERVICE_DEFS,
];
