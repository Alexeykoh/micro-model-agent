// Системный плагин Angular 11: знание фреймворка, проверки воркспейса и
// скаффолд по канону classic-NgModule-эпохи.
//
// Выключен по умолчанию: имя `angular11` лежит в `DEFAULTS.plugins.disabled`
// (`src/config/defaults.ts`), включается штатным контуром плагинов
// (`mma plugins enable angular11`, `/plugins`, тумблер в вебе).
//
// Спека: `docs/specs/2026-10-16-angular11-plugin-design.md`.
import type { AgentPlugin, PluginPermission } from "../../../types";
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from "../../../../tools/types";
import { ANGULAR11_KNOWLEDGE } from "./knowledge";
import { angularTools } from "./tools";
import { runWriteCheck } from "./write-check";

/** Плагин Angular 11: блок знания, `angular_check`, write-check, скаффолд. */
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

  /** Тулы плагина (F2 — `angular_check`). */
  getToolDefinitions(): ToolDefinition[] {
    return angularTools();
  }

  /** Проверка идиом Angular 11 после записи `.ts`/`.html` в воркспейсе (F3). */
  onAfterTool(ctx: ToolContext, call: ToolCall, result: ToolResult): void {
    runWriteCheck(ctx, call, result);
  }
}

/** Готовый инстанс для регистрации в bootstrap. */
export const plugin = new Angular11Plugin();
