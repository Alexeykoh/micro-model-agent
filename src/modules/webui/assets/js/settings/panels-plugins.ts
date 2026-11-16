// Plugins / MCP / LSP panel shell: status bar, three focused sub-tabs, plugin
// rows and the live registry reload. MCP lives in `panels-plugins-mcp.ts`, LSP
// in `panels-lsp.ts`; each file stays under the 300-line rule.
import { el, icon, makeToggle } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { PANEL_SECTIONS } from "./controls.js";
import { groupHeader, placeholderFor, renderSectionsInto } from "./panels-shared.js";
import { renderLspSection } from "./panels-lsp.js";
import { renderMcpSection } from "./panels-plugins-mcp.js";
import { openSubDialog } from "./subdialog.js";
import { mcpForm } from "./mcp-form.js";
import { pluginSettingsForm, settingsChip } from "./plugin-settings-form.js";

const TABS: Array<[string, string]> = [
  ["plugins", "web.settings.tab_plugins"],
  ["mcp", "web.settings.tab_mcp"],
  ["lsp", "web.settings.tab_lsp"],
];

// Stays across re-renders (registry reload, SSE plugins event, LSP refresh).
let activeTab = "plugins";

/** Перечитать каталоги с диска: выгрузка → сброс кэша → чтение заново. */
async function reloadPlugins(): Promise<void> {
  setIndicator(t("web.plugins.reloading"), false);
  const res = await api<Dict>("/api/reload/plugins", { method: "POST" });
  if (!res.ok || !res.data || res.data.ok !== true) {
    setIndicator(t("web.plugins.reload_failed"), true);
    return;
  }
  const report = ((res.data.reload as Dict) || {}) as { plugins?: Dict; skills?: Dict };
  const plugins = (report.plugins || {}) as Dict;
  const skills = (report.skills || {}) as Dict;
  const parts = [
    t("web.plugins.reload_done", {
      loaded: String(plugins.loaded ?? 0),
      unloaded: String(plugins.unloaded ?? 0),
      failed: String(plugins.failed ?? 0),
    }),
  ];
  if (Number(skills.added) > 0 || Number(skills.removed) > 0) {
    parts.push(
      t("web.plugins.reload_skills", {
        added: String(skills.added ?? 0),
        removed: String(skills.removed ?? 0),
      }),
    );
  }
  setIndicator(parts.join(" · "), Number(plugins.failed) > 0);
  // `.ts` под Node остаётся старым — говорим прямо, а не радуемся зря.
  if (Number(plugins.staleTs) > 0) {
    setIndicator(t("web.plugins.reload_stale", { count: String(plugins.staleTs) }), true);
  }
  await loadPlugins();
}

/** Живой тумблер плагина: POST + перечитывание (истина — ответ сервера). */
async function togglePlugin(name: string, on: boolean): Promise<void> {
  const res = await api<Dict>("/api/plugins/" + encodeURIComponent(name), {
    method: "POST",
    body: { enabled: on },
  });
  if (!res.ok || !res.data || res.data.ok !== true) {
    setIndicator(t("web.plugins.toggle_failed"), true);
    return;
  }
  settings.pluginsData = {
    plugins: (res.data.plugins as Dict[]) || [],
    mcp: (settings.pluginsData && settings.pluginsData.mcp) || [],
  };
  renderPluginsPanel();
}

/** Localized description for a plugin row; backend text is the fallback. */
function pluginDescription(p: Dict): string {
  const key = "web.plugins.system_desc." + String(p.name || "");
  const localized = t(key);
  if (localized !== key) return localized;
  return typeof p.description === "string" ? p.description : "";
}

/** Re-render the panel and re-read LSP servers after an inline edit. */
function refreshLsp(): void {
  renderPluginsPanel();
  void loadLsp();
}

function pane(name: string): HTMLElement {
  const box = el("div", "settings-pane");
  box.setAttribute("role", "tabpanel");
  box.dataset.pane = name;
  return box;
}

function statusBar(plugins: number, mcp: number, lsp: number): HTMLElement {
  const bar = el("div", "settings-status");
  bar.appendChild(
    el(
      "span",
      "settings-status-text",
      t("web.settings.integrations_status", {
        plugins: String(plugins),
        mcp: String(mcp),
        lsp: String(lsp),
      }),
    ),
  );
  const reload = el("button", "sec-add");
  reload.type = "button";
  reload.appendChild(icon("refresh"));
  reload.appendChild(el("span", "", t("web.plugins.reload")));
  reload.addEventListener("click", () => void reloadPlugins());
  bar.appendChild(reload);
  return bar;
}

/** One plugin card; `locked` marks harness modules as read-only. */
function pluginLine(p: Dict, locked: boolean): HTMLElement {
  const card = el("div", "plugin-card" + (locked ? " system-plugin" : ""));
  const head = el("div", "plugin-card-head");
  const title = el("div", "plugin-card-title");
  title.appendChild(el("span", "g", p.enabled === false ? "–" : "✓"));
  const nameEl = el("span", "name", p.name);
  nameEl.title = p.name;
  title.appendChild(nameEl);
  const meta: string[] = [];
  if (p.version) meta.push("v" + p.version);
  if (p.builtin) meta.push(t("web.settings.builtin"));
  if (p.source && !locked) meta.push(String(p.source));
  if (meta.length) {
    const metaEl = el("span", "plugin-card-meta", meta.join(" · "));
    metaEl.title = meta.join(" · ");
    title.appendChild(metaEl);
  }
  head.appendChild(title);

  if (locked) {
    // Системный модуль — часть харнесса: тумблер был бы ложным affordance
    // (его нельзя нажать). Состояние видно глифом `✓/–`.
    head.appendChild(el("span", "plugin-card-locked", t("web.settings.plugins_system_locked")));
  } else {
    const actions = el("div", "plugin-card-actions");
    const toggle = makeToggle(p.enabled !== false, () => {
      void togglePlugin(p.name, p.enabled === false);
    });
    toggle.title = t(p.enabled === false ? "web.plugins.enable" : "web.plugins.disable");
    toggle.setAttribute("aria-label", toggle.title);
    actions.appendChild(toggle);
    if (p.hasSettings === true) actions.appendChild(settingsChip(p.name, openPluginSettings));
    head.appendChild(actions);
  }
  card.appendChild(head);

  const desc = pluginDescription(p);
  if (desc) card.appendChild(el("div", "plugin-card-desc", desc));
  return card;
}

function pluginsPane(data: Dict | null, loaderSections: Dict[]): HTMLElement {
  const box = pane("plugins");
  if (!data) {
    box.appendChild(placeholderFor(settings.pluginsData, t("web.settings.plugins_unavailable")));
    renderSectionsInto(box, loaderSections);
    return box;
  }
  const all = (data.plugins || []) as Dict[];
  const system = all.filter((p) => p.system === true);
  const user = all.filter((p) => p.system !== true);
  const list = el("div", "settings-list");

  // User plugins first — they are the thing the user came to manage; harness
  // modules are read-only context and stay below.
  list.appendChild(
    Object.assign(groupHeader(t("web.settings.plugins_header"), user.length), {
      id: "settings-plugins",
    }),
  );
  if (!user.length) {
    list.appendChild(el("div", "placeholder", t("web.settings.no_plugins")));
  }
  user.forEach((p) => list.appendChild(pluginLine(p, false)));
  const pnote = el("div", "settings-note");
  pnote.textContent = t("web.settings.plugins_note");
  list.appendChild(pnote);

  if (system.length) {
    list.appendChild(
      Object.assign(groupHeader(t("web.settings.plugins_system_header"), system.length), {
        id: "settings-plugins-system",
      }),
    );
    const note = el("div", "settings-note compact");
    note.textContent = t("web.settings.plugins_system_note");
    list.appendChild(note);
    system.forEach((p) => list.appendChild(pluginLine(p, true)));
  }
  box.appendChild(list);
  renderSectionsInto(box, loaderSections);
  return box;
}

export function renderPluginsPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="plugins"]');
  if (!container) return;
  container.textContent = "";
  const data = settings.pluginsData || null;
  const all = data ? ((data.plugins || []) as Dict[]) : [];
  const mcp = data ? ((data.mcp || []) as Dict[]) : [];
  const lsp = Array.isArray(settings.lsp) ? settings.lsp.length : 0;
  const sections = PANEL_SECTIONS.plugins || [];
  container.appendChild(statusBar(all.length, mcp.length, lsp));
  const panes: Record<string, HTMLElement> = {
    plugins: pluginsPane(data, sections.filter((s) => s.id === "plugins.loader")),
    mcp: pane("mcp"),
    lsp: pane("lsp"),
  };
  if (data) {
    renderMcpSection(panes.mcp, data, { openForm: openMcpForm, reload: loadPlugins });
  } else {
    panes.mcp.appendChild(placeholderFor(data, t("web.settings.plugins_unavailable")));
  }
  renderLspSection(panes.lsp, refreshLsp);
  renderSectionsInto(
    panes.lsp,
    sections.filter((s) => s.id === "plugins.lsp"),
  );

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
  TABS.forEach(([key, labelKey]) => {
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
/** Open the MCP add/edit nested dialog. */
function openMcpForm(mode: string, entry: Dict | null): void {
  settings.mcpForm = { mode, entry: entry || null };
  openSubDialog(
    t(mode === "edit" ? "web.settings.mcp_edit_title" : "web.settings.mcp_add"),
    mcpForm(),
    () => {
      settings.mcpForm = null;
      renderPluginsPanel();
      void loadPlugins();
    },
  );
}

/** Open the plugin settings subpage (manifest + its own file). */
function openPluginSettings(name: string): void {
  void api<Dict>("/api/plugins/" + encodeURIComponent(name) + "/settings").then((res) => {
    if (!res.ok || !res.data || res.data.ok !== true) {
      setIndicator(t("web.settings.plugin_settings_failed"), true);
      return;
    }
    openSubDialog(
      t("web.settings.plugin_settings_title", { name }),
      pluginSettingsForm(name, res.data),
      () => {
        renderPluginsPanel();
        void loadPlugins();
      },
    );
  });
}

export async function loadPlugins(): Promise<void> {
  const r = await api<Dict>("/api/plugins");
  settings.pluginsData =
    r.ok && r.data ? { plugins: r.data.plugins || [], mcp: r.data.mcp || [] } : null;
  renderPluginsPanel();
}

export async function loadLsp(): Promise<void> {
  const r = await api<{ servers?: Dict[] }>("/api/lsp");
  settings.lsp = r.ok && r.data && Array.isArray(r.data.servers) ? r.data.servers : null;
  renderPluginsPanel();
}
