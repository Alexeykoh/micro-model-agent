// `/config reset` — сброс настроек к значениям снимка.
//
// Вынесено из `repl-commands.ts`: сброс — отдельная операция со своей
// политикой (json/list-значения, подтверждение, отчёт об ошибках).
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { resolveConfigKey, canonicalKeys, setConfigValue } from "../config/registry";
import { needsRebuild } from "../config/effects";
import {
  applyConfigSideEffects,
  confirm,
  mutateConfig,
  persistConfig,
  rawFromValue,
  renderConfigError,
} from "./config-mutations";
import type { ReplContext } from "./command-context";

/**
 * `/config reset [key] [--all] [--yes]` — сброс одного ключа или всех.
 *
 * Значения json/list сравниваются и сбрасываются по JSON: строка со значением
 * списка может содержать запятые (regex `a{1,3}`) (аудит §7.6).
 */
export async function runConfigReset(ctx: ReplContext, rest: string[]): Promise<void> {
  const snapshot = ctx.getConfigSnapshot();
  const yes = rest.includes("--yes");
  const all = rest.includes("--all");
  const target = rest.find((a) => !a.startsWith("--"));

  if (all) {
    const changed = canonicalKeys().filter((k) => {
      const def = resolveConfigKey(k);
      if (!def || !snapshot.has(k)) return false;
      return (
        rawFromValue(def.get(ctx.config), def.valueType) !==
        rawFromValue(snapshot.get(k), def.valueType)
      );
    });
    if (changed.length === 0) {
      ctx.output.writeLine(t("config.reset_none"));
      return;
    }
    if (!yes) {
      if (!process.stdin.isTTY) {
        ctx.output.writeLine(pc.yellow(t("config.reset_all_needs_yes")), "stderr");
        return;
      }
      const ok = await confirm(
        ctx,
        t("config.reset_all_confirm", { count: String(changed.length) }),
      );
      if (!ok) {
        ctx.output.writeLine(t("config.reset_cancelled"));
        return;
      }
    }
    let anyReconfig = false;
    let localeChanged = false;
    let applied = 0;
    const failures: string[] = [];
    for (const k of changed) {
      const def = resolveConfigKey(k);
      const kind = def?.valueType;
      const result = setConfigValue(ctx.config, k, rawFromValue(snapshot.get(k), kind));
      if (result.ok) {
        applied++;
        applyConfigSideEffects(ctx, result);
        anyReconfig = anyReconfig || needsRebuild(result.effects);
        localeChanged = localeChanged || result.key === "locale";
      } else {
        // Ошибка сброса — не повод считать ключ сброшенным (аудит §7.6).
        failures.push(k);
      }
    }
    persistConfig(ctx);
    if (anyReconfig) await ctx.agent.reconfigure(ctx.config);
    if (localeChanged) ctx.reregisterCommands();
    ctx.output.writeLine(pc.green(t("config.reset_all_done", { count: String(applied) })));
    for (const key of failures) {
      ctx.output.writeLine(pc.yellow(t("config.reset_failed", { key })), "stderr");
    }
    return;
  }

  if (!target) {
    ctx.output.writeLine(t("config.reset_usage"));
    return;
  }
  const def = resolveConfigKey(target);
  if (!def) {
    renderConfigError(ctx, { reason: "unknown-key", input: target });
    return;
  }
  if (def.readOnly || !snapshot.has(def.key)) {
    ctx.output.writeLine(t("config.reset_unchanged", { key: def.key }));
    return;
  }
  const current = rawFromValue(def.get(ctx.config), def.valueType);
  const original = rawFromValue(snapshot.get(def.key), def.valueType);
  if (current === original) {
    ctx.output.writeLine(t("config.reset_unchanged", { key: def.key }));
    return;
  }
  const result = await mutateConfig(ctx, def.key, original);
  if (!result.ok) {
    renderConfigError(ctx, result);
    return;
  }
  ctx.output.writeLine(
    pc.green(t("config.reset_ok", { key: result.key, value: result.display })),
  );
}
