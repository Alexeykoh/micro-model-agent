// Звуковые сигналы веб-UI (`mma web`). Вынесено из `registry-extra.ts`, чтобы
// не растягивать grandfathered-файл (правило 6); дефы — в DEFAULTS.ui.sounds.
// См. docs/specs/2026-10-31-webui-sounds-design.md.
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";

type SoundKey = "enabled" | "done" | "question" | "failed";

function soundDef(key: SoundKey): ConfigKeyDef {
  return {
    key: `ui.sounds.${key}`,
    aliases: [],
    domain: "ui",
    valueType: "bool",
    effects: [],
    get: (c: AppConfig) =>
      c.ui.sounds?.[key] ?? DEFAULTS.ui.sounds?.[key] ?? (key !== "enabled"),
    set: (c: AppConfig, v: unknown) => {
      c.ui.sounds ??= structuredClone(DEFAULTS.ui.sounds!);
      c.ui.sounds[key] = v as boolean;
    },
  };
}

/** Четыре ключа звука: мастер + события (INV-S5). */
export const SOUND_DEFS: ConfigKeyDef[] = [
  soundDef("enabled"),
  soundDef("done"),
  soundDef("question"),
  soundDef("failed"),
];
