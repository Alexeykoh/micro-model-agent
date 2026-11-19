// Pure row helpers for the Plugins sidebar tab: status glyph, version/author
// meta, source badges and the one-line description. Split out of plugins.ts so
// the interactive part stays under the 300-line rule.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";

/** Одна запись плагина из `GET /api/plugins` (свободная форма — расширяет ядро). */
export type PluginRow = Dict & { name: string; enabled: boolean };

/** Глиф и класс состояния: включён / выключен / не загрузился / с предупреждениями. */
export function pluginGlyph(row: PluginRow): [string, string] {
  if (!row.enabled) return ["–", "dim"];
  if ((row.warnings as string[] | undefined)?.length) return ["⚠", "warn"];
  return ["✓", "ok"];
}

/** Версия и автор — разными спанами: версия dim, автор акцентом. */
export function rowMeta(row: PluginRow): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (row.version) frag.appendChild(el("span", "plg-ver", "v" + String(row.version)));
  if (row.author) {
    if (row.version) frag.appendChild(document.createTextNode(" · "));
    frag.appendChild(el("span", "plg-author", String(row.author)));
  }
  return frag;
}

/** Чипсы источника/черновика: `builtin`, `project`, `draft`. */
export function badges(row: PluginRow): string {
  const out: string[] = [];
  if (row.draft) out.push(t("web.plugins.badge_draft"));
  else if (row.builtin) out.push(t("web.plugins.badge_builtin"));
  else if (row.source) out.push(String(row.source));
  return out.join(" · ");
}

/** Дима-строка описания под строкой. */
export function descriptionLine(row: PluginRow): HTMLElement | null {
  const text = String(row.description || "").trim();
  if (!text) return null;
  return el("div", "plg-desc", text.length > 90 ? text.slice(0, 89) + "…" : text);
}
