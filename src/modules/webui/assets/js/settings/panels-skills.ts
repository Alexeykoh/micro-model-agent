// Skills panel: read-only list of discovered skills (enabled/available/source).
// Grouped: built-in skills (shipped with the build) first, external (global/
// project) after. Extracted from `panels.ts` (rule 6).
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { placeholderFor } from "./panels-shared.js";

function renderSkillItem(s: Dict): HTMLElement {
  const item = el("div", "skill-item");
  const head = el("div", "skill-head");
  head.appendChild(el("span", s.enabled ? "g" : "dim", s.enabled ? "✓" : "○"));
  const nameEl = el("span", "name", s.name);
  nameEl.title = s.name;
  head.appendChild(nameEl);
  if (s.kind === "builtin") head.appendChild(el("span", "skill-badge", t("web.settings.skills_builtin")));
  head.appendChild(
    el("span", "st", s.enabled ? t("web.settings.enabled") : t("web.settings.available")),
  );
  item.appendChild(head);
  if (s.source) {
    const src = el("div", "skill-src", s.source);
    src.title = s.source;
    item.appendChild(src);
  }
  return item;
}

export function renderSkillsPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="skills"]');
  if (!container) return;
  container.textContent = "";
  if (settings.skills === undefined || settings.skills === null) {
    container.appendChild(placeholderFor(settings.skills, t("web.settings.skills_unavailable")));
    return;
  }
  if (!settings.skills.length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_skills");
    container.appendChild(empty);
    return;
  }
  const isBuiltin = (s: Dict): boolean => s.kind === "builtin";
  const all = settings.skills as Dict[];
  const builtinCount = all.filter(isBuiltin).length;

  const search = el("input", "searchbox");
  search.placeholder = t("web.settings.search_skills");
  search.setAttribute("aria-label", t("web.settings.search_skills"));
  container.appendChild(search);

  let filter = "all";
  const filters = el("div", "mem-filters");
  const filterDefs: Array<[string, string, number]> = [
    ["all", t("web.settings.skills_filter_all"), all.length],
    ["builtin", t("web.settings.skills_filter_builtin"), builtinCount],
    ["external", t("web.settings.skills_filter_external"), all.length - builtinCount],
  ];
  const filterButtons = new Map<string, HTMLElement>();
  filterDefs.forEach(([key, label, count]) => {
    const btn = el("button", "mem-filter", `${label} ${count}`);
    btn.type = "button";
    btn.classList.toggle("on", key === filter);
    btn.addEventListener("click", () => {
      filter = key;
      filterButtons.forEach((b, k) => b.classList.toggle("on", k === key));
      draw();
    });
    filters.appendChild(btn);
    filterButtons.set(key, btn);
  });
  container.appendChild(filters);

  const list = el("div", "settings-list");
  container.appendChild(list);

  const draw = (): void => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    const matches = (s: Dict): boolean =>
      (!q ||
        String(s.name).toLowerCase().indexOf(q) !== -1 ||
        String(s.source || "").toLowerCase().indexOf(q) !== -1) &&
      (filter === "all" || (filter === "builtin" ? isBuiltin(s) : !isBuiltin(s)));
    const groups = [
      { title: t("web.settings.skills_section_builtin"), items: all.filter((s) => isBuiltin(s) && matches(s)) },
      {
        title: t("web.settings.skills_section_external"),
        items: all.filter((s) => !isBuiltin(s) && matches(s)),
      },
    ];
    let any = false;
    for (const group of groups) {
      if (!group.items.length) continue;
      any = true;
      list.appendChild(el("div", "skill-section", group.title));
      for (const skill of group.items) list.appendChild(renderSkillItem(skill));
    }
    if (!any) list.appendChild(el("div", "placeholder", t("web.settings.no_matches")));
  };
  search.addEventListener("input", draw);
  draw();
}

export async function loadSkills(): Promise<void> {
  const r = await api<{ skills?: Dict[] }>("/api/skills");
  settings.skills = r.ok && r.data && Array.isArray(r.data.skills) ? r.data.skills : null;
  renderSkillsPanel();
}
