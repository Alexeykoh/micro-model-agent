// Registry keys for cost gateway (per-run budget USD, int —_config model: 0 = без лимита).
import { DEFAULTS } from "./defaults";
import type { ConfigKeyDef } from "./registry";
import { int } from "./registry-extra-factories";

export const COST_DEFS: ConfigKeyDef[] = [
  // Per-run бюджет в целых USD (0 = без лимита). Центы ломаются: конфиг-модель
  // реестра знает только int — доки честно говорят про целые доллары.
  int("cost.maxRunUsd", "agent", 0, 100000, 1, false,
    (c) => c.cost?.maxRunUsd ?? DEFAULTS.cost!.maxRunUsd,
    (c, v) => {
      c.cost ??= structuredClone(DEFAULTS.cost!);
      c.cost.maxRunUsd = v as number;
    }),
];

