// Registry keys for the execution profile (spec 2026-11-09-execution-sandbox-design):
// `execution.profile` local-trusted | sandbox + `execution.image`.
import { DEFAULTS } from "./defaults";
import type { ConfigKeyDef } from "./registry";
import { enumOf, str } from "./registry-extra-factories";

export const EXECUTION_DEFS: ConfigKeyDef[] = [
  enumOf("execution.profile", "agent", ["local-trusted", "sandbox"] as const, true,
    (c) => c.execution?.profile ?? DEFAULTS.execution!.profile,
    (c, v) => {
      c.execution ??= structuredClone(DEFAULTS.execution!);
      c.execution.profile = v as "local-trusted" | "sandbox";
    }),
  str("execution.image", "agent",
    (c) => c.execution?.image ?? DEFAULTS.execution!.image,
    (c, v) => {
      c.execution ??= structuredClone(DEFAULTS.execution!);
      c.execution.image = String(v);
    }),
];
