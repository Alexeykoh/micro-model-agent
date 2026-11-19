// Memory panel: category list, search, add nested dialog and forget action.
// Extracted from `panels.ts` (rule 6); shares labels/placeholders with
// `./panels-shared.js`.
import { el, icon, link, inlineTextNodes } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { placeholderFor, renderSectionsInto } from "./panels-shared.js";
import { PANEL_SECTIONS } from "./controls.js";
import { openSubDialog, closeSubDialog } from "./subdialog.js";
import { mcpLiteralField } from "./form.js";

const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"];

/** Nested dialog: pick a memory category and write the note. */
function openMemoryForm(): void {
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const catSel = el("select");
  catSel.setAttribute("aria-label", t("web.settings.memory_category"));
  MEMORY_CATEGORIES.forEach((c) => catSel.appendChild(el("option", "", c)));
  catSel.value = "facts";
  grid.appendChild(mcpLiteralField(t("web.settings.memory_category"), catSel));
  box.appendChild(grid);
  const area = el("textarea");
  area.rows = 5;
  area.placeholder = t("web.settings.new_memory");
  area.value = "";
  box.appendChild(mcpLiteralField(t("web.settings.new_memory"), area));
  const actions = el("div", "pform-actions");
  actions.appendChild(
    link(t("web.settings.save"), "", async () => {
      const text = area.value.trim();
      if (!text) {
        area.focus();
        return;
      }
      const r = await api<Dict>("/api/memory", {
        method: "POST",
        body: { category: catSel.value, text },
      });
      if (r.ok && r.data && r.data.ok) {
        closeSubDialog();
        await loadMemory();
      } else {
        setIndicator(t("web.settings.add_failed"), true);
      }
    }),
  );
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  openSubDialog(t("web.settings.memory_add_title"), box, () => renderMemoryPanel());
}

export function renderMemoryPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="memory"]');
  if (!container) return;
  container.textContent = "";
  // Validation/retention rules live here, next to the notes they govern, but
  // collapsed: the common task is browsing notes, not retuning the gate.
  const rules = el("details", "settings-details");
  const rulesSum = el("summary", "settings-details-summary");
  rulesSum.textContent = t("web.settings.sec.memory.rules");
  rules.appendChild(rulesSum);
  const rulesBody = el("div", "settings-details-body");
  renderSectionsInto(rulesBody, PANEL_SECTIONS.memory || []);
  rulesBody.querySelectorAll(".settings-section .sec-head").forEach((h) => h.remove());
  rules.appendChild(rulesBody);
  container.appendChild(rules);
  if (settings.memory === undefined || settings.memory === null) {
    container.appendChild(placeholderFor(settings.memory, t("web.settings.memory_unavailable")));
    return;
  }
  const data = settings.memory;

  // Adding an entry opens the shared nested dialog: a category + a multi-line
  // note with room to write, instead of a cramped inline field.
  const addBtn = el("button", "sec-add");
  addBtn.type = "button";
  addBtn.appendChild(icon("plus"));
  addBtn.appendChild(el("span", "", t("web.settings.add")));
  addBtn.addEventListener("click", () => openMemoryForm());
  const addHead = el("div", "sec-head");
  addHead.appendChild(el("span", "sec-title", t("web.settings.sec.memory.add")));
  addHead.appendChild(addBtn);
  const addSec = el("div", "settings-section");
  addSec.appendChild(addHead);
  container.appendChild(addSec);

  const search = el("input", "searchbox");
  search.placeholder = t("web.settings.search_memory");
  search.setAttribute("aria-label", t("web.settings.search_memory"));
  container.appendChild(search);

  // Category filter chips: the list is long, and "where is that rule?" usually
  // starts with a category, not a full-text query.
  let selected = "all";
  const filters = el("div", "mem-filters");
  const categories = (data.categories || []) as Dict[];
  const entriesOf = (c: Dict) => (c.entries || []) as Dict[];
  const filterDefs: Array<[string, string, number | null]> = [
    ["all", t("web.settings.memory_filter_all"), categories.reduce((n, c) => n + entriesOf(c).length, 0)],
    ...categories.map((c: Dict): [string, string, number] => [
      String(c.name),
      String(c.name),
      entriesOf(c).length,
    ]),
  ];
  const filterButtons = new Map<string, HTMLElement>();
  filterDefs.forEach(([key, label, count]) => {
    const btn = el("button", "mem-filter", label + (count == null ? "" : ` ${count}`));
    btn.type = "button";
    btn.classList.toggle("on", key === selected);
    btn.addEventListener("click", () => {
      selected = key;
      filterButtons.forEach((b, k) => b.classList.toggle("on", k === key));
      draw();
    });
    filters.appendChild(btn);
    filterButtons.set(key, btn);
  });
  container.appendChild(filters);

  const list = el("div", "settings-list");
  container.appendChild(list);

  const categoryHeader = (label: string, count?: number | null) => {
    const head = el("div", "mem-cat");
    head.appendChild(el("span", "", label));
    if (count != null) head.appendChild(el("span", "n", String(count)));
    return head;
  };

  const entryBlock = (text: unknown, onForget?: () => void) => {
    const block = el("div", "mem-entry");
    const body = el("span", "mem-text");
    body.appendChild(inlineTextNodes(String(text == null ? "" : text)));
    body.title = String(text == null ? "" : text);
    block.appendChild(body);
    if (onForget) block.appendChild(link(t("web.settings.forget"), "mem-del", onForget));
    return block;
  };

  const draw = () => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    let any = false;
    categories.forEach((cat: Dict) => {
      if (selected !== "all" && String(cat.name) !== selected) return;
      const entries = (cat.entries || []).filter(
        (e: Dict) => !q || String(e.text).toLowerCase().indexOf(q) !== -1,
      );
      if (!entries.length) return;
      any = true;
      list.appendChild(categoryHeader(cat.name, entries.length));
      entries.forEach((e: Dict) => {
        list.appendChild(
          entryBlock(e.text, async () => {
            const r = await api("/api/memory/" + encodeURIComponent(cat.name) + "/" + e.n, {
              method: "DELETE",
            });
            if (r.ok) await loadMemory();
            else setIndicator(t("web.settings.forget_failed"), true);
          }),
        );
      });
    });
    const prefs = Object.entries(data.preferences || {});
    if (prefs.length && !q && selected === "all") {
      any = true;
      list.appendChild(categoryHeader(t("web.settings.preferences"), prefs.length));
      prefs.forEach(([k, v]) => {
        list.appendChild(entryBlock(k + " = " + v));
      });
    }
    if (!any) {
      const empty = el("div", "placeholder");
      empty.textContent = q ? t("web.settings.no_matches") : t("web.settings.no_memory");
      list.appendChild(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
}

export async function loadMemory(): Promise<void> {
  const r = await api<Dict>("/api/memory");
  settings.memory = r.ok && r.data ? r.data : null;
  renderMemoryPanel();
}
