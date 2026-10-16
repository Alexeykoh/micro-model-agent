// Системный плагин Angular 11: знание фреймворка, проверки воркспейса и
// скаффолд по канону classic-NgModule-эпохи.
//
// Выключен по умолчанию: имя `angular11` лежит в `DEFAULTS.plugins.disabled`
// (`src/config/defaults.ts`), включается штатным контуром плагинов
// (`mma plugins enable angular11`, `/plugins`, тумблер в вебе).
//
// Спека: `docs/specs/2026-10-16-angular11-plugin-design.md`.
import type { AgentPlugin, PluginPermission } from "../../../types";
import { ANGULAR11_KNOWLEDGE } from "./knowledge";

/** Плагин Angular 11. Пока (W1) отдаёт только блок знания. */
export class Angular11Plugin implements AgentPlugin {
  name = "angular11";
  version = "0.1.0";
  priority = 5;
  isBuiltin = true;
  author = "mma";
  description = "Angular 11 knowledge, workspace checks and scaffolding (off by default).";
  homepage = "https://github.com/micro-models-agent";
  permissions: PluginPermission[] = ["fs:read", "fs:write"];

  /** Блок `[ANGULAR 11]` в системный промпт, пока плагин включён (F1). */
  onBuildPrompt(): string | null {
    return ANGULAR11_KNOWLEDGE;
  }
}

/** Готовый инстанс для регистрации в bootstrap. */
export const plugin = new Angular11Plugin();
