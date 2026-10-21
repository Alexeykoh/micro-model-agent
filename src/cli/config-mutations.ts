// Общий путь мутации настроек REPL: валидация, сайд-эффекты, персист.
//
// Вынесено из `repl-commands.ts`: это контракт записи конфига для ВСЕХ
// slash-команд, а не часть одной команды (правило 6 AGENTS).
import { join, dirname } from "path";
import { pc } from "../ui/colors";
import { t, setLocale } from "../i18n/index";
import { saveConfig } from "../config/config";
import { needsRebuild } from "../config/effects";
import {
  setConfigValue,
  resolveConfigKey,
  canonicalKeys,
  type ConfigKeyDef,
  type ConfigSetResult,
} from "../config/registry";
import type { ReplContext } from "./command-context";

/** Подсказка по типу значения ключа. */
export function configValueHint(def?: ConfigKeyDef): string {
  if (!def) return "";
  switch (def.valueType) {
    case "enum":
      return t("config.hint_enum", { values: (def.enumValues ?? []).join(", ") });
    case "bool":
      return t("config.hint_bool");
    case "share":
      return t("config.hint_share");
    case "int":
      return t("config.hint_int", { min: String(def.min ?? 1) });
    default:
      return t("config.hint_string");
  }
}

/** Расстояние редактирования (для подсказки «возможно, вы имели в виду»). */
function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Ближайший ключ конфига (для подсказки при опечатке). */
function nearestConfigKey(input: string): string | null {
  const names = canonicalKeys();
  let best: { name: string; dist: number } | null = null;
  for (const name of names) {
    const d = editDistance(input.toLowerCase(), name.toLowerCase());
    if (best === null || d < best.dist) best = { name, dist: d };
  }
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(best.name.length / 3));
  return best.dist <= threshold ? best.name : null;
}

/** Показывает ошибку записи ключа. */
export function renderConfigError(
  ctx: ReplContext,
  result: { reason: string; input: string; key?: string; def?: ConfigKeyDef },
): void {
  const key = result.key ?? result.input;
  switch (result.reason) {
    case "unknown-key": {
      const suggestion = nearestConfigKey(result.input);
      const suffix = suggestion
        ? t("config.suggest", { name: suggestion })
        : t("config.valid_keys", { keys: canonicalKeys().join(", ") });
      ctx.output.writeLine(
        pc.yellow(t("config.unknown_key", { key: result.input, suggestion: suffix })),
        "stderr",
      );
      return;
    }
    case "read-only":
      ctx.output.writeLine(pc.yellow(t("config.read_only", { key })), "stderr");
      return;
    case "range":
      ctx.output.writeLine(pc.yellow(t("config.range", { key })), "stderr");
      return;
    case "combined":
      ctx.output.writeLine(pc.yellow(t("config.combined")), "stderr");
      return;
    default:
      ctx.output.writeLine(
        pc.yellow(t("config.invalid_value", { key, hint: configValueHint(result.def) })),
        "stderr",
      );
  }
}

/** Сайд-эффекты применённой настройки. */
export function applyConfigSideEffects(
  ctx: ReplContext,
  result: ConfigSetResult & { ok: true },
): void {
  if (result.key === "ui.verbosity") {
    // Зеркало стартового правила (`main.ts`): структурные info-логи и диагностика
    // петли видны в чате только в verbose.
    const verbose = (result.value as string) === "verbose";
    ctx.output.setSuppressInfoLogs?.(!verbose);
    ctx.output.setShowDiagnostics?.(verbose);
  } else if (result.key === "reasoning.mode") {
    ctx.agent.setReasoningLevel(result.value as "auto" | "default" | "none" | "low" | "medium" | "high" | "max");
  } else if (result.key === "locale") {
    setLocale(result.value as string);
  }
}

/** Персист конфига на диск. */
export function persistConfig(ctx: ReplContext): void {
  const configPath = join(ctx.configDir, "config.json");
  saveConfig(ctx.config, configPath, dirname(configPath));
}

/**
 * Единый путь записи каждой мутации настроек. Сахарные команды тоже идут сюда,
 * чтобы валидация, сайд-эффекты, персист и reconfigure не расходились.
 */
export async function mutateConfig(
  ctx: ReplContext,
  key: string,
  raw: string,
): Promise<ConfigSetResult> {
  const result = setConfigValue(ctx.config, key, raw);
  if (!result.ok) return result;
  applyConfigSideEffects(ctx, result);
  persistConfig(ctx);
  if (needsRebuild(result.effects)) await ctx.agent.reconfigure(ctx.config);
  if (result.key === "locale") ctx.reregisterCommands();
  return result;
}

/**
 * Строковое представление значения для сброса/сравнения.
 *
 * Для `json` и `list` это JSON: значение списка может содержать запятые
 * (regex `a{1,3}`), и разбиение по запятой портило значение (аудит §7.6).
 */
export function rawFromValue(value: unknown, kind?: string): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (kind === "json" || kind === "list") return JSON.stringify(value);
  return String(value);
}

/** Подтверждение через фронтендовый ввод (`ctx.input.confirm`). */
export function confirm(ctx: ReplContext, prompt: string): Promise<boolean> {
  return ctx.input.confirm(prompt);
}

/** Ключ по точному имени или ближайшему совпадению. */
export function resolveKeyFor(input: string): ConfigKeyDef | undefined {
  return resolveConfigKey(input) ?? undefined;
}
