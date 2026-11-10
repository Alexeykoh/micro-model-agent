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
  const groups = [
    { title: t("web.settings.skills_section_builtin"), items: settings.skills.filter(isBuiltin) },
    {
      title: t("web.settings.skills_section_external"),
      items: settings.skills.filter((s: Dict) => !isBuiltin(s)),
    },
  ];
  const list = el("div", "settings-list");
  for (const group of groups) {
    if (!group.items.length) continue;
    list.appendChild(el("div", "skill-section", group.title));
    for (const skill of group.items) list.appendChild(renderSkillItem(skill));
  }
  container.appendChild(list);
}

export async function loadSkills(): Promise<void> {
  const r = await api<{ skills?: Dict[] }>("/api/skills");
  settings.skills = r.ok && r.data && Array.isArray(r.data.skills) ? r.data.skills : null;
  renderSkillsPanel();
}
