// Индикатор загруженных скиллов в композере (веб-UI).
//
// Само-инициализируется при импорте (как composer-draft.ts): ищет #skillsBtn
// в DOM и заполняет Lucide-иконкой + счётчиком, навешивает тултип.
// Состояние живёт здесь (один синглтон-индикатор на окно); источник истины —
// SSE-событие `skills` (single source of truth; sse.ts вызывает applySkillsEvent).
//
// Скиллы — процессный синглтон SkillsModule, поэтому набор одинаков во всех
// вкладках; индикатор показывает ровно то, что попало в системный промпт.
import { el, icon, attachTooltip } from "../dom.js";
import { t } from "../i18n.js";
import { hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";

interface LoadedSkill {
  name: string;
  kind: string;
}

let loaded: LoadedSkill[] = [];

const host = document.getElementById("skillsBtn") as HTMLButtonElement | null;

function kindLabel(kind: string): string {
  const key = `web.composer.skill_kind_${kind}`;
  const v = t(key);
  return v === key ? kind : v;
}

function render(): void {
  if (!host) return;
  host.hidden = loaded.length === 0;
  const badge = host.querySelector<HTMLElement>(".skills-badge");
  if (badge) {
    badge.textContent = loaded.length > 0 ? String(loaded.length) : "";
  }
  host.setAttribute("aria-label", t("web.composer.skills_aria", { count: loaded.length }));
}

function buildTooltip(): Node {
  const frag = el("div", "qtip");
  const head = el("div", "qtip-row");
  head.appendChild(el("span", "ctip-label", t("web.composer.skills_title")));
  head.appendChild(el("span", "ctip-pct", String(loaded.length)));
  frag.appendChild(head);
  const note = el("div", "qtip-row");
  note.appendChild(el("span", "ctip-label", t("web.composer.skills_note")));
  frag.appendChild(note);
  for (const s of loaded) {
    const row = el("div", "qtip-row");
    row.appendChild(el("span", "ctip-label", s.name));
    row.appendChild(el("span", "ctip-pct", kindLabel(s.kind)));
    frag.appendChild(row);
  }
  return frag;
}

export function applySkillsEvent(d: Dict): void {
  const list = Array.isArray(d.skills) ? d.skills : [];
  loaded = list.map((s) => ({ name: String(s.name), kind: String(s.kind ?? "global") }));
  render();
}

export function refreshSkillsIndicatorI18n(): void {
  render();
}

if (host) {
  host.replaceChildren(icon("biceps-flexed"), el("span", "skills-badge", ""));
  attachTooltip(host, buildTooltip);
  host.addEventListener("click", () => hooks.openSettingsAt?.("skills"));
  render();
}