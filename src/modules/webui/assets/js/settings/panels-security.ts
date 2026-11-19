// Security settings: one overview with the master switches, then focused tabs
// for shell/path rules, network, audit/encryption, DLP and access.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { PANEL_SECTIONS } from "./controls.js";
import { renderSectionsInto, row } from "./panels-shared.js";

const TABS: Array<[string, string, string[]]> = [
  ["overview", "web.settings.tab_security_overview", ["security.master", "security.switches", "security.limits"]],
  [
    "shell",
    "web.settings.tab_security_shell",
    ["security.bash", "security.paths", "security.scan"],
  ],
  ["network", "web.settings.tab_security_network", ["security.network"]],
  [
    "audit",
    "web.settings.tab_security_audit",
    ["security.audit", "security.approvals", "security.encryption"],
  ],
  [
    "dlp",
    "web.settings.tab_security_dlp",
    ["security.dataPolicy", "security.dlp.provider", "security.dlp.clients"],
  ],
  ["access", "web.settings.tab_security_access", []],
];

let activeTab = "overview";

/** Read-only access card: web token + terminal note. */
function accessSection(): HTMLElement {
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
  return access;
}

export function renderSecurityPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="security"]');
  if (!container) return;
  container.textContent = "";
  const sections = PANEL_SECTIONS.security || [];
  const panes: Record<string, HTMLElement> = {};
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (key: string): void => {
    if (!panes[key]) return;
    activeTab = key;
    for (const [name, node] of Object.entries(panes)) node.hidden = name !== key;
    for (const [name, btn] of buttons) {
      btn.classList.toggle("on", name === key);
      btn.setAttribute("aria-selected", name === key ? "true" : "false");
    }
  };

  const tabs = el("div", "settings-tabs");
  tabs.setAttribute("role", "tablist");
  TABS.forEach(([key, labelKey, ids]) => {
    const pane = el("div", "settings-pane");
    pane.setAttribute("role", "tabpanel");
    pane.dataset.pane = key;
    renderSectionsInto(
      pane,
      sections.filter((s: Dict) => ids.includes(String(s.id))),
    );
    if (key === "access") pane.appendChild(accessSection());
    panes[key] = pane;

    const btn = el("button", "settings-tab", t(labelKey));
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => select(key));
    tabs.appendChild(btn);
    buttons.set(key, btn);
  });

  container.appendChild(tabs);
  Object.values(panes).forEach((node) => container.appendChild(node));
  select(activeTab);
}
