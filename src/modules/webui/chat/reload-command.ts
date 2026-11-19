/**
 * `/reload` для web: мягкий re-read конфига и `AGENTS.md` без перезапуска
 * процесса. Живёт отдельно от `commands.ts`, чтобы диспетчер не разрастался.
 */
import { t } from "../../../i18n/index";
import { applySoftReload, type ReloadState } from "../reload";
import type { Handler } from "./commands-shared";

/** Собирает хендлер `/reload`, привязанный к состоянию сервера. */
export function makeReloadHandler(state: ReloadState): Handler {
  return async (_args, out) => {
    const report = await applySoftReload(state);
    out(
      t("web.command.reload_done", {
        files: report.files.length,
        blocks: report.instructions,
        dropped: report.dropped,
      }),
    );
  };
}
