// Git-состояние для строки футера под композером (спека git-workflow §6.3).
//
// Вынесено из `feed/sidebar.ts` (правило 6). Git живёт В ТОЙ ЖЕ строке, что
// путь и версия: отдельный блок под футером давал «столбик» из двух строк и
// выглядел неопрятно. Сборку самих чипов делает `footer.ts` (листовой модуль,
// тестируется без DOM); здесь — источник данных, подписи и перерисовка строки.
import { wsLine, el } from "../dom.js";
import { t } from "../i18n.js";
import { renderFooter, type FooterGit } from "../footer.js";
import { hiddenText } from "../format.js";
import { sidebarGitIndicator, openGitChangesTab } from "../sidebar.js";
import type { Dict } from "../core/store/types.js";

/** Снимок git из состояния как словарь (полный тип на клиенте не нужен). */
export interface GitSnap extends FooterGit {
  worktrees?: { path: string; branch: string }[];
}

/** Подписи git-чипов для футера (переводятся здесь, не в `footer.ts`). */
export function gitFooterLabels(): { changes: string; detached: string } {
  return { changes: t("web.git.changes"), detached: t("web.git.detached") };
}

/** Снимок git из состояния хоста, либо null вне репозитория. */
export function gitSnapFrom(h: Dict): GitSnap | null {
  return h.git && typeof h.git === "object" ? (h.git as GitSnap) : null;
}

/** Точка на вкладке Changes: число изменённых файлов. */
export function syncGitIndicator(snap: GitSnap | null): void {
  sidebarGitIndicator(typeof snap?.dirty === "number" ? snap.dirty : 0);
}

/** Клик по бейджу в футере открывает вкладку Changes. */
export function openChangesFromBadge(): void {
  openGitChangesTab();
}

/**
 * Перерисовывает строку футера под композером вместе с git-бейджем: путь,
 * ветка, число изменений, версия — всё в одной строке. Идемпотентно по ключу
 * (`renderFooter` сам сравнивает вход), поэтому вызывается каждый тик состояния.
 */
export function paintGitChips(h: Dict): void {
  const snap = gitSnapFrom(h);
  renderFooter(
    wsLine,
    {
      workspace: typeof h.workspace === "string" ? hiddenText(h.workspace) : h.workspace,
      version: h.version,
      updateAvailable: h.updateAvailable || undefined,
      dev: h.dev === true,
      devTitle: t("web.env.dev_title"),
      dirLabel: t("web.env.dir"),
      updateTitle: t("web.update.chip_title", { latest: h.updateAvailable?.latest ?? "" }),
      git: snap,
      gitLabels: gitFooterLabels(),
    },
    el,
  );
  syncGitIndicator(snap);
}
