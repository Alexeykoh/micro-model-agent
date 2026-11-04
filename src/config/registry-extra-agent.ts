// Дефы агента, сессий, UI, retry, updater и плагинов. Вынесены из
// `registry-extra.ts` (правило 6); порядок внутри группы — порядок `EXTRA_DEFS`.
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";
import { THEME_MODES, UI_THEME_IDS, type ThemeMode, type UiThemeId } from "./theme-ids";
import { bool, enumOf, int, list, share } from "./registry-extra-factories";

export const AGENT_EXTRA_DEFS: ConfigKeyDef[] = [
  bool("autoPlan", "agent", true,
    (c) => c.autoPlan,
    (c, v) => { c.autoPlan = v as boolean; }),
  bool("tools.enableOnDemand", "agent", true,
    (c) => c.tools.enableOnDemand,
    (c, v) => { c.tools.enableOnDemand = v as boolean; }),
  enumOf("tools.grepEngine", "agent", ["auto", "rg", "grep", "js"] as const, false,
    (c) => c.tools.grepEngine ?? DEFAULTS.tools.grepEngine,
    (c, v) => { c.tools.grepEngine = v as "auto" | "rg" | "grep" | "js"; }),

  bool("session.autoSave", "session", false,
    (c) => c.session?.autoSave ?? DEFAULTS.session.autoSave,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.autoSave = v as boolean;
    }),
  int("session.maxSessions", "session", 1, 500, 1, false,
    (c) => c.session?.maxSessions ?? DEFAULTS.session.maxSessions,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.maxSessions = v as number;
    }),
  bool("session.isolateMemory", "session", false,
    (c) => c.session?.isolateMemory ?? DEFAULTS.session.isolateMemory,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.isolateMemory = v as boolean;
    }),
  bool("session.autoName", "session", false,
    (c) => c.session?.autoName ?? DEFAULTS.session.autoName,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.autoName = v as boolean;
    }),

  bool("sessionIsolation.enabled", "session", false,
    (c) => c.sessionIsolation?.enabled ?? DEFAULTS.sessionIsolation!.enabled,
    (c, v) => {
      c.sessionIsolation ??= structuredClone(DEFAULTS.sessionIsolation!);
      c.sessionIsolation.enabled = v as boolean;
    }),
  bool("sessionIsolation.isolateTempFiles", "session", false,
    (c) => c.sessionIsolation?.isolateTempFiles ?? DEFAULTS.sessionIsolation!.isolateTempFiles,
    (c, v) => {
      c.sessionIsolation ??= structuredClone(DEFAULTS.sessionIsolation!);
      c.sessionIsolation.isolateTempFiles = v as boolean;
    }),

  bool("ui.spinner", "ui", false,
    (c) => c.ui.spinner, (c, v) => { c.ui.spinner = v as boolean; }),
  enumOf("ui.activityRail", "ui", ["off", "line", "meta", "full"] as const, false,
    (c) => c.ui.activityRail ?? "line",
    (c, v) => { c.ui.activityRail = v as "off" | "line" | "meta" | "full"; }),
  bool("ui.showContextStats", "ui", false,
    (c) => c.ui.showContextStats,
    (c, v) => { c.ui.showContextStats = v as boolean; }),
  bool("ui.showCompaction", "ui", false,
    (c) => c.ui.showCompaction,
    (c, v) => { c.ui.showCompaction = v as boolean; }),
  enumOf("ui.fontSize", "ui", ["compact", "comfortable", "large"] as const, false,
    (c) => c.ui.fontSize ?? "comfortable",
    (c, v) => { c.ui.fontSize = v as "compact" | "comfortable" | "large"; }),
  // Тема — серверная настройка веб-UI (см. docs/specs/2026-10-30-webui-theme-
  // persistence-design.md): `localStorage` держит только кэш для pre-paint.
  // Эффектов нет, поэтому ключи правятся и во время хода (INV-T3).
  enumOf("ui.theme", "ui", UI_THEME_IDS, false,
    (c) => c.ui.theme ?? "console",
    (c, v) => { c.ui.theme = v as UiThemeId; }),
  enumOf("ui.themeMode", "ui", THEME_MODES, false,
    (c) => c.ui.themeMode ?? "auto",
    (c, v) => { c.ui.themeMode = v as ThemeMode; }),

  int("retry.maxRetries", "agent", 0, 10, 1, false,
    (c) => c.retry.maxRetries,
    (c, v) => { c.retry.maxRetries = v as number; }),
  int("retry.baseDelay", "agent", 0, 60000, 100, false,
    (c) => c.retry.baseDelay,
    (c, v) => { c.retry.baseDelay = v as number; }),
  int("retry.maxDelay", "agent", 0, 300000, 1000, false,
    (c) => c.retry.maxDelay,
    (c, v) => { c.retry.maxDelay = v as number; }),
  int("retry.maxStreamRetries", "agent", 0, 10, 1, false,
    (c) => c.retry.maxStreamRetries ?? DEFAULTS.retry.maxStreamRetries,
    (c, v) => { c.retry.maxStreamRetries = v as number; }),
  int("retry.noDataTimeoutMs", "agent", 1000, 600000, 1000, false,
    (c) => c.retry.noDataTimeoutMs ?? DEFAULTS.retry.noDataTimeoutMs,
    (c, v) => { c.retry.noDataTimeoutMs = v as number; }),

  bool("pricing.enabled", "pricing", false,
    (c) => c.pricing?.enabled ?? DEFAULTS.pricing!.enabled,
    (c, v) => {
      c.pricing ??= structuredClone(DEFAULTS.pricing!);
      c.pricing.enabled = v as boolean;
    }),

  bool("updater.enabled", "updater", false,
    (c) => c.updater.enabled,
    (c, v) => { c.updater.enabled = v as boolean; }),
  bool("updater.autoInstall", "updater", false,
    (c) => c.updater.autoInstall,
    (c, v) => { c.updater.autoInstall = v as boolean; }),
  int("updater.intervalMs", "updater", 0, 86400000, 60000, false,
    (c) => c.updater.intervalMs,
    (c, v) => { c.updater.intervalMs = v as number; }),

  share("skills.budget", "agent", false,
    (c) => c.skills.budget,
    (c, v) => { c.skills.budget = v as number; }),

  // Deny-list плагинов: эффект `plugins.gate` идёт через `applyConfigEffects`.
  {
    ...list(
      "plugins.disabled",
      "agent",
      (c) => c.plugins?.disabled ?? DEFAULTS.plugins!.disabled,
      (c, v) => {
        c.plugins ??= structuredClone(DEFAULTS.plugins);
        (c.plugins as NonNullable<AppConfig["plugins"]>).disabled = (v as string[])
          .map((n) => n.trim())
          .filter(Boolean);
      },
      { kind: "tags", placeholder: "my-plugin" },
    ),
    effects: ["plugins.gate"],
  },

  // Лимит черновиков capabilities на проект (LRU-вытеснение). Ключ видит хост
  // черновиков через живой конфиг, поэтому `reconfigure: false`.
  int("plugins.maxDrafts", "agent", 10, 100, 1, false,
    (c) => c.plugins?.maxDrafts ?? DEFAULTS.plugins!.maxDrafts!,
    (c, v) => {
      c.plugins ??= structuredClone(DEFAULTS.plugins);
      (c.plugins as NonNullable<AppConfig["plugins"]>).maxDrafts = Math.max(1, v as number);
    }),
];
