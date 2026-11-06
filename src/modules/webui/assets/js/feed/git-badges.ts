// Вывод git-чипов под композером (спека git-workflow §6.3).
//
// Вынесено из `feed/sidebar.ts` (правило 6): сам рендер — тонкая обвязка над
// чистым билдером `git-chips.ts`, единственное место, знающее про элементы
// `#wsGit` и индикатор вкладки Changes.
import { wsGitEl, el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { renderGitChips } from "./git-chips.js";
import { sidebarGitIndicator, openGitChangesTab } from "../sidebar.js";

/** Снимок git из состояния как словарь (тип на клиенте не тянят). */
interface GitSnap {
  repo?: boolean;
  dirty?: number;
}

/**
 * Рисует чипы из снапшота состояния и прячет контейнер, когда чипов нет:
 * пустая строка под композером — шум. Снимок приходит с сервера (`h.git`),
 * на клиенте git не вызывается.
 */
export function paintGitChips(h: Dict): void {
  if (!wsGitEl) return;
  const snap = (h.git && typeof h.git === "object" ? h.git : null) as GitSnap | null;
  renderGitChips(
    wsGitEl,
    snap,
    {
      changes: t("web.git.changes"),
      branchTitle: t("web.git.chip_branch"),
      detachedTitle: t("web.git.chip_detached"),
      worktrees: t("web.git.chip_worktrees"),
      syncTitle: t("web.git.chip_sync"),
      tag: t("web.git.chip_tag"),
    },
    el,
    () => openGitChangesTab(),
  );
  wsGitEl.hidden = wsGitEl.childElementCount === 0;
  sidebarGitIndicator(typeof snap?.dirty === "number" ? snap.dirty : 0);
}
