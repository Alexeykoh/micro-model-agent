/**
 * Общие помощники групп slash-команд: отчёт о сохранении настройки, таблица
 * `/config` и статус reasoning.
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { printConfigTable } from "./repl-config-table";
import type { ConfigKeyDef, ConfigSetResult } from "../config/registry";
import type { ReplContext } from "./repl-commands";

/** Отчёт об успешной записи настройки. */
export function reportSaved(ctx: ReplContext, result: ConfigSetResult & { ok: true }): void {
  ctx.output.writeLine(pc.green(t("config.saved", { key: result.key })));
}

/** Таблица настроек + строка активной сессии (формат — в `repl-config-table.ts`). */
export function showConfigTable(ctx: ReplContext, defs?: ConfigKeyDef[], page = 1): void {
  printConfigTable(ctx.output, (def) => def.get(ctx.config), defs, page);
  const meta = ctx.sessionManager?.getActiveMeta();
  if (meta) {
    ctx.output.writeLine(
      pc.dim(
        t("config.session_line", {
          name: meta.name,
          id: meta.id,
          count: String(meta.messageCount),
        }),
      ),
    );
  }
  ctx.output.writeLine(pc.dim(t("config.usage_hint")));
}

export function printReasoningStatus(ctx: ReplContext): void {
  const display = ctx.config.showReasoning ? t("reasoning.on") : t("reasoning.off");
  const mode = ctx.config.reasoning?.mode ?? "auto";
  const auto = mode === "auto" ? t("reasoning.auto_on") : t("reasoning.auto_off");
  ctx.output.writeLine(t("reasoning.status", { display, level: mode, auto }));
}
