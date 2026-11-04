// Settings panels facade: generic registry rendering (PANEL_SECTIONS cards),
// the general "about/update" card and the ui/security bespoke panels. The
// memory / skills / plugins·MCP·LSP panels and the shared builders live in
// `panels-*.ts` (rule 6) and are re-exported here so `settings.js` and the
// settings shell keep one import site.
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { getUpdateInfo } from "../update-state.js";
import { PANEL_SECTIONS } from "./controls.js";
import { buildThemeCard } from "./theme-panel.js";
import { defFor, row, renderSections } from "./panels-shared.js";

export function renderPanel(panel: string): void {
  const container = document.querySelector('[data-panel="' + panel + '"]');
  if (!container) return;
  container.textContent = "";
  if (panel === "general") container.appendChild(aboutCard());
  renderSections(panel, PANEL_SECTIONS[panel] || []);
}

// General panel "about" row: installed version + update dot + install button.
// Bespoke (not a registry key) because it mixes a read-only value with an action.
function aboutCard(): HTMLElement {
  const upd = getUpdateInfo();
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t("web.update.sec")));
  card.appendChild(head);
  const body = el("div", "sec-body");
  const r = el("div", "row upd-row");
  const left = el("div", "row-label");
  left.appendChild(el("span", "row-name", "micro-models-agent"));
  const ver = defFor("version")?.value;
  if (ver !== undefined && ver !== null) {
    const v = el("span", "val", String(ver));
    v.title = String(ver);
    left.appendChild(v);
  }
  r.appendChild(left);
  if (upd) {
    const right = el("div", "upd-right");
    right.appendChild(el("span", "upd-dot"));
    const btn = el("button", "upd-btn", t("web.update.install"));
    btn.type = "button";
    btn.addEventListener("click", () => void runUpdateFromSettings(btn));
    right.appendChild(btn);
    r.appendChild(right);
  }
  body.appendChild(r);
  card.appendChild(body);
  return card;
}

async function runUpdateFromSettings(btn: HTMLElement): Promise<void> {
  btn.setAttribute("disabled", "disabled");
  btn.textContent = t("web.update.installing");
  const r = await api<{ ok?: boolean; installed?: string; error?: string }>("/api/update", {
    method: "POST",
    body: {},
  });
  if (r.ok && r.data && r.data.ok) {
    setIndicator(t("web.update.installed", { latest: r.data.installed || "" }), false);
  } else {
    setIndicator(t("web.update.failed"), true);
    btn.removeAttribute("disabled");
    btn.textContent = t("web.update.install");
  }
}

// --- UI panel (mode + theme) ----------------------------------------------
// Тема — серверная настройка (`ui.themeMode`/`ui.theme`), карточка и запись
// живут в `theme-panel.ts`; здесь только разметка панели.
export function renderUiPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="ui"]');
  if (!container) return;
  container.textContent = "";
  container.appendChild(buildThemeCard(renderUiPanel, row));
  renderSections("ui", PANEL_SECTIONS.ui || []);
}

// --- Security panel ------------------------------------------------------
export function renderSecurityPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="security"]');
  if (!container) return;
  container.textContent = "";
  renderSections("security", PANEL_SECTIONS.security || []);
  const access = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t("web.settings.sec.security.access")));
  access.appendChild(head);
  const body = el("div", "sec-body");
  body.appendChild(
    row(
      t("web.settings.web_token"),
      el("span", "val dim", settings.webToken || t("web.settings.web_token_none")),
      t("config.desc.webToken"),
    ),
  );
  const note = el("div", "placeholder");
  note.appendChild(el("span", "tag", t("web.settings.terminal_tag")));
  note.appendChild(document.createTextNode(" " + t("web.settings.security_note")));
  body.appendChild(note);
  access.appendChild(body);
  container.appendChild(access);
}

export {
  configLabel,
  enumLabel,
  defFor,
  descFor,
  row,
  renderSections,
  settingsSection,
  chip,
  placeholderFor,
  groupHeader,
} from "./panels-shared.js";
export { renderMemoryPanel, loadMemory } from "./panels-memory.js";
export { renderSkillsPanel, loadSkills } from "./panels-skills.js";
export { renderPluginsPanel, loadPlugins, loadLsp } from "./panels-plugins.js";
