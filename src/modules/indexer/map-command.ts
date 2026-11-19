// Команда карты проекта, общая для `mma map` (CLI) и `/map` (REPL).
import type { IndexerModule } from "./module";
import { t } from "../../i18n/index";

/** Результат действия карты: успех + текстовый вывод. */
export interface MapActionResult {
  ok: boolean;
  output: string;
}

/**
 * Общая реализация команды карты проекта для `mma map` (CLI) и `/map` (REPL):
 * summary (точный текст из системного промпта), refresh и find.
 */
export async function runMapAction(
  module: IndexerModule,
  action: string,
  query?: string,
): Promise<MapActionResult> {
  const summary = async (): Promise<MapActionResult> => {
    const result = await module.buildIndex();
    if (!result) return { ok: false, output: t("indexer.not_indexed") };
    return { ok: true, output: module.getPromptMap() ?? t("indexer.not_indexed") };
  };

  switch (action) {
    case "refresh": {
      const result = await module.refresh();
      if (!result) return { ok: false, output: t("indexer.not_indexed") };
      return {
        ok: true,
        output: `${t("map.refreshed")}\n${module.getPromptMap() ?? ""}`.trimEnd(),
      };
    }
    case "find": {
      const q = (query ?? "").trim();
      if (!q) return { ok: false, output: t("map.find_usage") };
      await module.buildIndex();
      return { ok: true, output: module.formatFind(q) };
    }
    default:
      return summary();
  }
}
