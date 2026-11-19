// Registry keys for OTel observability (P0, spec 2026-11-09-otel-design):
// `otel.enabled`, `otel.endpoint`, `otel.serviceName`.
import { DEFAULTS } from "./defaults";
import type { ConfigKeyDef } from "./registry";
import { bool, str } from "./registry-extra-factories";

export const OTEL_DEFS: ConfigKeyDef[] = [
  bool("otel.enabled", "agent", false,
    (c) => c.otel?.enabled ?? DEFAULTS.otel!.enabled,
    (c, v) => {
      c.otel ??= structuredClone(DEFAULTS.otel!);
      c.otel.enabled = v as boolean;
    }),
  str("otel.endpoint", "agent",
    (c) => c.otel?.endpoint ?? DEFAULTS.otel!.endpoint,
    (c, v) => {
      c.otel ??= structuredClone(DEFAULTS.otel!);
      c.otel.endpoint = String(v);
    }),
  str("otel.serviceName", "agent",
    (c) => c.otel?.serviceName ?? DEFAULTS.otel!.serviceName,
    (c, v) => {
      c.otel ??= structuredClone(DEFAULTS.otel!);
      c.otel.serviceName = String(v);
    }),
];
