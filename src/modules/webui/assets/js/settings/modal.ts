// Settings shell: the modal overlay, its section tablist, `renderSettings`
// dispatch and open/close/escape. Extracted from `settings.js`. Also registers
// the render callbacks the write funnel (`settings/write.js`) calls back into.
import { hooks, settings } from "../store.js";
import { closeConfirm, confirmOverlay, trapTab } from "../dialog.js";
import {
  renderPanel, renderUiPanel, renderMemoryPanel, renderSkillsPanel,
  renderPluginsPanel, renderSecurityPanel,
  loadMemory, loadSkills, loadPlugins, loadLsp,
} from "./panels.js";
import { renderModelPanel } from "./providers.js";
import { closeSubDialog, isSubDialogOpen } from "./subdialog.js";
import { setWriteHooks } from "./write.js";

export function renderSettings(): void {
  // Generic panels render straight from PANEL_SECTIONS; custom panels
  // (model/ui/memory/skills/plugins/security) append their sections themselves
  // or render bespoke widgets alongside.
  for (const panel of ["general", "context", "reasoning", "agent", "network", "browser", "sessions", "advanced"]) {
    renderPanel(panel);
  }
  renderModelPanel();
  renderUiPanel();
  renderMemoryPanel();
  renderSkillsPanel();
  renderPluginsPanel();
  renderSecurityPanel();
}

const overlay = document.getElementById("overlay") as HTMLElement;
const settingsBtn = document.getElementById("openSettings") as HTMLElement;
const closeSettingsBtn = document.getElementById("closeSettings") as HTMLElement;
let settingsReturnFocus: HTMLElement | null = null;

// Settings sections act as a real tablist: roles, roving tabindex, arrow keys.
const settingsTabs: HTMLElement[] = Array.from(document.querySelectorAll<HTMLElement>("#setMenu .mi"));
export function selectSettingsPanel(name: string): void {
  settingsTabs.forEach((x) => {
    const on = x.dataset.p === name;
    x.classList.toggle("on", on);
    x.setAttribute("aria-selected", on ? "true" : "false");
    x.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".content-col .panel").forEach((x) => x.classList.remove("on"));
  const panel = document.getElementById("p-" + name);
  if (panel) panel.classList.add("on");
}
settingsTabs.forEach((mi) => {
  const name = mi.dataset.p || "";
  mi.setAttribute("role", "tab");
  mi.setAttribute("id", "tab-" + name);
  mi.setAttribute("aria-controls", "p-" + name);
  mi.setAttribute("aria-selected", mi.classList.contains("on") ? "true" : "false");
  mi.tabIndex = mi.classList.contains("on") ? 0 : -1;
  mi.addEventListener("click", () => selectSettingsPanel(name));
  mi.addEventListener("keydown", (e) => {
    const i = settingsTabs.indexOf(mi);
    let next: HTMLElement | null = null;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = settingsTabs[(i + 1) % settingsTabs.length];
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = settingsTabs[(i - 1 + settingsTabs.length) % settingsTabs.length];
    else if (e.key === "Home") next = settingsTabs[0];
    else if (e.key === "End") next = settingsTabs[settingsTabs.length - 1];
    if (next) {
      e.preventDefault();
      selectSettingsPanel(next.dataset.p || "");
      next.focus();
    }
  });
});
document.querySelectorAll(".content-col .panel").forEach((panel) => {
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", "tab-" + panel.id.replace(/^p-/, ""));
});

function openSettings(): void {
  settingsReturnFocus = document.activeElement as HTMLElement | null;
  overlay.classList.add("open");
  settingsBtn.setAttribute("aria-expanded", "true");
  void loadMemory();
  void loadSkills();
  void loadPlugins();
  void loadLsp();
  const active = document.querySelector<HTMLElement>("#setMenu .mi.on") || settingsTabs[0];
  if (active) setTimeout(() => active.focus(), 0);
}
// Open settings straight at a panel (used by the reasoning selector when the
// backend probe failed: the row links to Settings → Reasoning).
function openSettingsAt(panel: string): void {
  openSettings();
  selectSettingsPanel(panel);
}
/** Хук для сайдбара: быстрый переход в нужную панель настроек. */
hooks.openSettingsAt = openSettingsAt;
function closeSettings(): void {
  closeSubDialog();
  settings.providerForm = null;
  settings.mcpForm = null;
  settings.lspForm = null;
  overlay.classList.remove("open");
  settingsBtn.setAttribute("aria-expanded", "false");
  if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}
settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeSettings();
});
// Trap Tab inside the dialog while it is open.
overlay.addEventListener("keydown", (e) => trapTab(overlay, e));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (isSubDialogOpen()) closeSubDialog();
  else if (confirmOverlay && confirmOverlay.classList.contains("open")) closeConfirm();
  else if (overlay.classList.contains("open")) closeSettings();
});

// The write funnel calls back into the shell for full re-renders.
setWriteHooks({ renderSettings, openSettingsAt });
