// Манифесты настроек встроенных плагинов: схема + типизированное чтение.
// Схемы живут здесь, а не в файлах плагинов: `lint-on-write.ts` стоит ровно
// на потолке правила 6, любой лишний блок требует сплита. Значения — в
// `<MMA_CONFIG_DIR>/plugin-settings/<name>.settings.json` (в `src/` писать
// нельзя), чтение — через `readBuiltinSettings` (кэш по mtime).
import type { PluginSettingDef } from "../../types";
import { readBuiltinSettings } from "../settings-store";

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Настройки `lint-on-write`: какие проверки гонять после записи. */
export const LINT_ON_WRITE_SCHEMA: PluginSettingDef[] = [
  { key: "syntaxCheck", type: "boolean", title: "Syntax check", default: true },
  { key: "projectLint", type: "boolean", title: "Project lint", default: true },
  { key: "typeCheck", type: "boolean", title: "Project typecheck", default: true },
  { key: "autoFix", type: "boolean", title: "Auto-fix", default: true },
];

export interface LintOnWriteSettings {
  syntaxCheck: boolean;
  projectLint: boolean;
  typeCheck: boolean;
  autoFix: boolean;
}

export function lintOnWriteSettings(configDir?: string): LintOnWriteSettings {
  const s = readBuiltinSettings("lint-on-write", LINT_ON_WRITE_SCHEMA, configDir);
  return {
    syntaxCheck: flag(s.syntaxCheck, true),
    projectLint: flag(s.projectLint, true),
    typeCheck: flag(s.typeCheck, true),
    autoFix: flag(s.autoFix, true),
  };
}

/** Настройки `notify`: по каким исходам хода слать уведомление. */
export const NOTIFY_SCHEMA: PluginSettingDef[] = [
  { key: "onSuccess", type: "boolean", title: "Notify on success", default: true },
  { key: "onFailure", type: "boolean", title: "Notify on failure", default: true },
  { key: "onInterrupted", type: "boolean", title: "Notify on interrupt", default: true },
];

export interface NotifySettings {
  onSuccess: boolean;
  onFailure: boolean;
  onInterrupted: boolean;
}

export function notifySettings(configDir?: string): NotifySettings {
  const s = readBuiltinSettings("notify", NOTIFY_SCHEMA, configDir);
  return {
    onSuccess: flag(s.onSuccess, true),
    onFailure: flag(s.onFailure, true),
    onInterrupted: flag(s.onInterrupted, true),
  };
}

/** Настройки `angular11`: проверки воркспейса после записи. */
export const ANGULAR11_SCHEMA: PluginSettingDef[] = [
  { key: "writeCheck", type: "boolean", title: "Write check", default: true },
];

export function angular11Settings(configDir?: string): { writeCheck: boolean } {
  const s = readBuiltinSettings("angular11", ANGULAR11_SCHEMA, configDir);
  return { writeCheck: flag(s.writeCheck, true) };
}
