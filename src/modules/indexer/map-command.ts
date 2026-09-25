import type { IndexerModule } from "./module";
import { t } from "../../i18n/index";

export interface MapActionResult {
  ok: boolean;
  output: string;
}

/**
 * Shared implementation of the project-map command used by both `mma map`
 * (CLI) and `/map` (REPL): summary (the exact text injected into the system
 * prompt), refresh, and find.
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
