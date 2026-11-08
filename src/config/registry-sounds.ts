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
      c.ui.sounds?.[key] ?? DEFAULTS.ui.sounds?.[key] ?? true,
    set: (c: AppConfig, v: unknown) => {
      c.ui.sounds ??= structuredClone(DEFAULTS.ui.sounds!);
      c.ui.sounds[key] = v as boolean;
    },
  };
}

function volumeDef(): ConfigKeyDef {
  return {
    key: "ui.sounds.volume",
    aliases: [],
    domain: "ui",
    valueType: "int",
    min: 0,
    max: 100,
    step: 5,
    effects: [],
    get: (c: AppConfig) => c.ui.sounds?.volume ?? DEFAULTS.ui.sounds?.volume ?? 50,
    set: (c: AppConfig, v: unknown) => {
      c.ui.sounds ??= structuredClone(DEFAULTS.ui.sounds!);
      c.ui.sounds.volume = Number(v);
    },
  };
}

/** Ключи звука: мастер + события + громкость. */
export const SOUND_DEFS: ConfigKeyDef[] = [
  soundDef("enabled"),
  soundDef("done"),
  soundDef("question"),
  soundDef("failed"),
  volumeDef(),
];