// Settings search: index over the same PANEL_SECTIONS table that renders the
// panels + each key's i18n label/description, so search can never disagree with
// the layout. Extracted from `settings.js`.
import { el, icon } from "../dom.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { keyToPanel } from "./controls.js";
import { configLabel, descFor, defFor } from "./panels.js";
import { selectSettingsPanel } from "./modal.js";

const setMenuEl = document.getElementById("setMenu");
const setSearch = document.getElementById("setSearch") as HTMLInputElement | null;
const setSearchClear = document.getElementById("setSearchClear");
const setSearchIcon = document.getElementById("setSearchIcon");
const setResults = document.getElementById("setResults");
if (setSearchIcon) setSearchIcon.appendChild(icon("search", "set-search-svg"));

interface SearchEntry {
  def: Dict;
  panel: string;
  label: string;
  desc: string;
  haystack: string;
}

function searchIndex(): SearchEntry[] {
  const owner = keyToPanel();
  return (settings.registry || [])
    .filter((def) => def && typeof def.key === "string")
    .map((def) => {
      const label = configLabel(def);
      const desc = descFor(def.key);
      return {
        def,
        panel: owner.get(def.key) || "",
        label,
        desc,
        haystack: `${label} ${def.key} ${desc}`.toLowerCase(),
      };
    })
    .filter((e) => e.panel);
}

let searchRows: SearchEntry[] = [];
let searchCursor = -1;

function closeSearch(): void {
  if (setSearch) setSearch.value = "";
  if (setResults) {
    setResults.hidden = true;
    setResults.textContent = "";
  }
  if (setMenuEl) setMenuEl.hidden = false;
  if (setSearchClear) setSearchClear.hidden = true;
  searchRows = [];
  searchCursor = -1;
}

function flashRow(panel: string, key: string): void {
  const panelEl = document.getElementById("p-" + panel);
  if (!panelEl) return;
  const rows = Array.from(panelEl.querySelectorAll(".row"));
  const def = defFor(key);
  if (!def) return;
  const label = configLabel(def);
  const target = rows.find((r) => {
    const nameEl = r.querySelector(".row-name");
    return nameEl && nameEl.textContent === label;
  });
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.classList.add("row-flash");
  setTimeout(() => target.classList.remove("row-flash"), 1200);
}

function pickResult(entry: SearchEntry | undefined): void {
  if (!entry || !entry.panel) return;
  closeSearch();
  selectSettingsPanel(entry.panel);
  flashRow(entry.panel, entry.def.key);
}

function renderResults(query: string): void {
  if (!setResults) return;
  const q = query.trim().toLowerCase();
  if (!q) {
    closeSearch();
    return;
  }
  const matches = searchIndex().filter((e) => e.haystack.includes(q));
  setResults.textContent = "";
  if (!matches.length) {
    const empty = el("div", "set-results-empty", t("web.settings.search_empty"));
    setResults.appendChild(empty);
  }
  searchRows = matches.slice(0, 40);
  searchCursor = searchRows.length ? 0 : -1;
  searchRows.forEach((entry, i) => {
    const item = el("div", "set-result" + (i === searchCursor ? " on" : ""));
    item.setAttribute("role", "option");
    item.tabIndex = -1;
    item.appendChild(el("span", "sr-label", entry.label));
    const panelName = t("web.settings." + entry.panel);
    item.appendChild(el("span", "sr-panel", panelName === "web.settings." + entry.panel ? entry.panel : panelName));
    const keyEl = el("span", "sr-key", entry.def.key);
    keyEl.title = entry.def.key;
    item.appendChild(keyEl);
    item.addEventListener("click", () => pickResult(entry));
    setResults.appendChild(item);
  });
  setResults.hidden = false;
  if (setMenuEl) setMenuEl.hidden = true;
  if (setSearchClear) setSearchClear.hidden = false;
}

function moveSearchCursor(delta: number): void {
  if (!searchRows.length || !setResults) return;
  searchCursor = (searchCursor + delta + searchRows.length) % searchRows.length;
  Array.from(setResults.children).forEach((node, i) => node.classList.toggle("on", i === searchCursor));
  const active = setResults.children[searchCursor];
  if (active) active.scrollIntoView({ block: "nearest" });
}

if (setSearch) {
  setSearch.addEventListener("input", () => renderResults(setSearch.value));
  setSearch.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSearchCursor(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSearchCursor(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickResult(searchRows[searchCursor]);
    } else if (e.key === "Escape" && setSearch.value) {
      // First Esc clears the query; a second one is handled globally (close).
      e.stopPropagation();
      closeSearch();
    }
  });
}
if (setSearchClear) setSearchClear.addEventListener("click", closeSearch);
