// Таблица настроек REPL: значения, домены и подсказки по смене.
//
// Вынесено из `repl-commands.ts`: это представление конфига, а не команды
// (правило 6 AGENTS).
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { renderTable } from "../ui/table";
import { configDefs, formatConfigValue, type ConfigKeyDef } from "../config/registry";

/** Куда печатать таблицу. */
export interface ConfigTableSink {
  writeLine(text: string): void;
}

/** Сколько строк настроек показываем на странице (аудит §8.14). */
export const CONFIG_PAGE_ROWS = 40;

/** Короткие подсказки «как поменять» для частых ключей. */
const SUGAR_HINTS: Record<string, string> = {
  model: "/model use <name>",
  "provider.active": "/provider use <name>",
  contextWindow: "/context <size>",
  "contextBudget.systemPrompt": "/context system <share>",
  "contextBudget.responseReserve": "/context reserve <share>",
  showReasoning: "/reasoning show | hide",
  "reasoning.mode": "/reasoning level <level>",
  "ui.verbosity": "/verbose <level>",
};

/** Подсказка по смене настройки. */
function changeHint(def: ConfigKeyDef): string {
  if (def.readOnly) return t("config.read_only_hint");
  return SUGAR_HINTS[def.key] ?? `/config ${def.key} <value>`;
}

/**
 * Таблица настроек (текущее значение + подсказка по смене), постранично:
 * без пагинации список настроек — это простыня (аудит §8.14).
 * DEBT(config-pager-keys): интерактивного пейджера с `↑`/`↓` пока нет.
 */
export function printConfigTable(
  ctx: ConfigTableSink,
  getValue: (def: ConfigKeyDef) => unknown,
  defs?: ConfigKeyDef[],
  page = 1,
): void {
  const list = defs ?? configDefs();
  const allRows = list.map((def) => [
    def.key,
    formatConfigValue(getValue(def)),
    def.domain,
    changeHint(def),
  ]);
  const pages = Math.max(1, Math.ceil(allRows.length / CONFIG_PAGE_ROWS));
  const current = Math.min(Math.max(1, page), pages);
  const rows = allRows.slice((current - 1) * CONFIG_PAGE_ROWS, current * CONFIG_PAGE_ROWS);
  ctx.writeLine(pc.bold(t("config.header")));
  for (const line of renderTable(
    [
      t("config.col_setting"),
      t("config.col_value"),
      t("config.col_domain"),
      t("config.col_change"),
    ],
    rows,
  )) {
    ctx.writeLine(line);
  }
  if (pages > 1) {
    ctx.writeLine(
      pc.dim(
        t("config.page_footer", {
          page: String(current),
          pages: String(pages),
          next: String(current < pages ? current + 1 : current),
        }),
      ),
    );
  }
}
