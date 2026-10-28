// Итог диагностики LSP для вкладки: «проверено 14:03 · серверов 4/4 ok».
//
// Вынесено из `sidebar/lsp.ts`, который упёрся в потолок 300 строк: рендер
// вкладки остался там, а формат итоговой строки живёт здесь.
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { el } from "../dom.js";

/**
 * Причины, которые не заслуживают отдельной строки: сервер либо не применим к
 * проекту, либо выключен. Вкладка схлопывает их в одну dim-строку на причину,
 * а итог считает только по применимым серверам.
 */
export const MUTED_REASONS = new Set(["not-applicable", "disabled"]);

/**
 * Итог последней диагностики. `checkedAt = null` — данные пришли из кэша сервера
 * (после перезагрузки страницы), показываем только счётчики.
 *
 * Раньше панель после проверки возвращалась к тому же виду, и отличить
 * «проверено, всё в порядке» от «ничего не произошло» было нельзя.
 */
export function lspCheckSummary(diag: Dict | null, checkedAt: number | null): string | null {
  if (!diag) return null;
  const servers: Dict[] = Array.isArray(diag.servers) ? diag.servers : [];
  if (servers.length === 0) return null;
  const applicable = servers.filter((s) => !MUTED_REASONS.has(String(s.reason)));
  const ok = applicable.filter((s) => s.reason === "ok").length;
  const counts = { ok: String(ok), total: String(applicable.length) };
  if (typeof checkedAt !== "number") return t("web.sidebar.lsp_checked_counts", counts);
  const d = new Date(checkedAt);
  const time = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return t("web.sidebar.lsp_checked_at", { ...counts, time });
}

/** Дописать итоговую строку в панель (no-op, если считать нечего). */
export function appendLspSummary(host: HTMLElement, diag: Dict | null, checkedAt: number | null): void {
  const summary = lspCheckSummary(diag, checkedAt);
  if (summary) host.appendChild(el("div", "lsp-hint", summary));
}
