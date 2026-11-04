// Static-chrome localization for the app shell: re-applies the dictionary to
// buttons, headings, hints and placeholders after a locale switch. Extracted
// from `app.ts` (file-size rule 6). Dynamic feeds (tool output, model text) are
// localized server-side and untouched.
import { msgs, inp, connStatus, setIcon } from "./js/dom.js";
import { I18N, t } from "./js/i18n.js";
import { renderSelectors, setConnStatus, setStaleBar } from "./js/settings.js";
import { setGreetResolver } from "./js/loader.js";
import { showEmptyFeed } from "./js/feed.js";
import { renderSessionsDropdown } from "./js/session/tabs.js";
import { applyRailI18n } from "./js/rail.js";
import { applySidebarI18n } from "./js/sidebar.js";

export function applyStaticI18n(): void {
  document.documentElement.lang = I18N.locale;
  const setText = (id: string, text: string) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  setText("planHeaderLabel", t("web.sidebar.plan"));
  setText("usageHeaderLabel", t("web.sidebar.session") + " · " + t("web.sidebar.usage"));
  setText("envHeaderLabel", t("web.sidebar.env"));
  setText("settingsTitle", t("web.settings.title"));
  setText("sessActiveHeader", t("web.sessions.active"));
  setText("sessRecentHeader", t("web.sessions.recent"));
  setText("hintEnter", t("web.input.enter"));
  setText("hintShift", t("web.input.shift_enter"));
  setText("hintEsc", t("web.input.esc")); setText("hintAttach", t("web.input.attach"));
  setText("hintShort", t("web.input.shortcuts"));
  // Стадия boot (A3) важнее общей подписи: её не затираем при локализации.
  const bootCap = document.getElementById("bootCap");
  if (bootCap && !bootCap.dataset.stage) bootCap.textContent = t("web.loader.boot");
  // MMART's click bubble: bound lazily (not at import) so `loader.ts` stays
  // import-safe under `bun test`, and re-bound here after a locale switch.
  setGreetResolver(() => t("web.loader.greet"));
  // A bubble already open must restate the greeting in the new locale.
  const greetTip = document.getElementById("composerFace")?.querySelector<HTMLElement>(".mdl-tip");
  if (greetTip) greetTip.textContent = t("web.loader.greet");

  // Chrome controls: Lucide icon + label, plus matching title/aria-label.
  const controls: Record<string, [string, string]> = {
    newChat: ["plus", t("web.topbar.new_chat")],
    sessBtn: ["menu", t("web.topbar.all_sessions")],
    toggleSidebar: ["panel", t("web.topbar.sidebar")],
    openSettings: ["settings", t("web.topbar.settings")],
    attachBtn: ["image", t("web.attach.title")],
    closeSettings: ["x", t("web.topbar.close")],
    sessNew: ["plus", t("web.sessions.new")],
    sessRefresh: ["refresh", t("web.sessions.refresh")],
    sessPrev: ["chevron-left", t("web.sessbar.prev")],
    sessNext: ["chevron-right", t("web.sessbar.next")],
    sessClose: ["x", t("web.topbar.close")],
  };
  Object.keys(controls).forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    const [name, label] = controls[id];
    // Text-bearing buttons keep their label; icon-only ones don't add one.
    const withLabel = id === "closeSettings" || id === "sessNew" || id === "sessRefresh";
    setIcon(node, name, withLabel ? label : null);
    node.title = label;
    node.setAttribute("aria-label", label);
  });
  const settingsIcon = document.getElementById("settingsIcon");
  if (settingsIcon) setIcon(settingsIcon, "settings", null);
  if (inp) {
    inp.placeholder = t("web.input.placeholder");
    inp.setAttribute("aria-label", t("web.input.placeholder"));
  }

  document.querySelectorAll<HTMLElement>("#setMenu .mi").forEach((mi) => {
    const p = mi.dataset.p;
    if (p) mi.textContent = t("web.settings." + p);
  });
  const settingsSearch = document.getElementById("setSearch");
  if (settingsSearch) {
    settingsSearch.setAttribute("placeholder", t("web.settings.search_placeholder"));
    settingsSearch.setAttribute("aria-label", t("web.settings.search_placeholder"));
  }
  document.querySelectorAll(".content-col .panel").forEach((panel) => {
    const h3 = panel.querySelector("h3");
    const name = panel.id.replace(/^p-/, "");
    if (h3 && name) h3.textContent = t("web.settings." + name);
  });

  renderSelectors();
  renderSessionsDropdown();
  applyRailI18n();
  applySidebarI18n();
  if (msgs.querySelector(".empty")) showEmptyFeed();
  if (connStatus && !connStatus.hidden) setConnStatus(true);
  setStaleBar(undefined, true);
}
