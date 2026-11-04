// Plugins / MCP / LSP panel: system + user plugin rows, live toggles, reload,
// MCP server list with add/edit dialog, and the LSP section. Extracted from
// `panels.ts` (rule 6); the LSP part lives in `./panels-lsp.js`.
import { el, icon, makeToggle } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { PANEL_SECTIONS } from "./controls.js";
import { groupHeader, placeholderFor, chip, renderSections } from "./panels-shared.js";
import { renderLspSection } from "./panels-lsp.js";
import { openSubDialog } from "./subdialog.js";
import { mcpForm } from "./mcp-form.js";

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

export function renderPluginsPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="plugins"]');
  if (!container) return;
  container.textContent = "";
  if (settings.pluginsData === undefined || settings.pluginsData === null) {
    container.appendChild(
      placeholderFor(settings.pluginsData, t("web.settings.plugins_unavailable")),
    );
    return;
  }
  const data = settings.pluginsData;
  const all = (data.plugins || []) as Dict[];
  const system = all.filter((p) => p.system === true);
  const user = all.filter((p) => p.system !== true);
  const list = el("div", "settings-list");

  /** One plugin row; `locked` marks harness modules as read-only. */
  const pluginLine = (p: Dict, locked: boolean): HTMLElement => {
    const line = el("div", "list-line" + (locked ? " system-plugin" : ""));
    line.appendChild(el("span", "g", p.enabled === false ? "–" : "✓"));
    const nameEl = el("span", "name", p.name);
    nameEl.title = p.name;
    line.appendChild(nameEl);
    if (p.version) line.appendChild(el("span", "src", "v" + p.version));
    if (p.source && !locked) {
      const src = el("span", "src", p.source);
      src.title = p.source;
      line.appendChild(src);
    }
    if (p.builtin) line.appendChild(el("span", "src", t("web.settings.builtin")));
    const desc = pluginDescription(p);
    if (desc) line.appendChild(el("span", "plugin-desc", desc));
    if (locked) {
      // Системный модуль — часть харнесса: тумблер был бы ложным affordance
      // (его нельзя нажать). Состояние уже видно глифом `✓/–`, остаётся
      // тихая пометка «системный · всегда включён».
      const note = el("span", "src system-note", t("web.settings.plugins_system_locked"));
      line.appendChild(note);
    } else {
      // Живой тумблер вместо статуса: тот же контракт, что у строки MCP ниже.
      // `onFlip` ничего не возвращает — состояние перерисовывается из ответа.
      line.appendChild(
        makeToggle(p.enabled !== false, () => {
          void togglePlugin(p.name, p.enabled === false);
        }),
      );
    }
    return line;
  };

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

  list.appendChild(
    Object.assign(groupHeader(t("web.settings.plugins_header"), user.length), {
      id: "settings-plugins",
    }),
  );
  if (!user.length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_plugins");
    list.appendChild(empty);
  }
  user.forEach((p) => list.appendChild(pluginLine(p, false)));
  const pnote = el("div", "settings-note");
  pnote.textContent = t("web.settings.plugins_note");
  list.appendChild(pnote);
  const reloadBtn = el("button", "sec-add");
  reloadBtn.type = "button";
  reloadBtn.appendChild(icon("refresh"));
  reloadBtn.appendChild(el("span", "", t("web.plugins.reload")));
  reloadBtn.addEventListener("click", () => void reloadPlugins());
  list.appendChild(reloadBtn);

  list.appendChild(
    Object.assign(groupHeader(t("web.settings.mcp_servers"), (data.mcp || []).length), {
      id: "settings-mcp",
    }),
  );
  const mcpAdd = el("button", "sec-add");
  mcpAdd.type = "button";
  mcpAdd.appendChild(icon("plus"));
  mcpAdd.appendChild(el("span", "", t("web.settings.mcp_add")));
  mcpAdd.addEventListener("click", () => openMcpForm("add", null));
  list.appendChild(mcpAdd);
  if (!(data.mcp || []).length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_mcp");
    list.appendChild(empty);
  }
  (data.mcp || []).forEach((m: Dict) => {
    const line = el("div", "list-line");
    const on = m.status !== "disabled";
    const toggle = makeToggle(on, (next) => {
      void api<Dict>("/api/mcp/" + encodeURIComponent(m.id || m.name), {
        method: "POST",
        body: { enabled: next },
      }).then(async (r) => {
        if (r.ok && r.data && r.data.ok) {
          setIndicator(t("web.settings.mcp_saved"), false);
          await loadPlugins();
        } else {
          setIndicator(t("web.settings.save_failed"), true);
        }
      });
    });
    toggle.title = on ? t("web.settings.mcp_disable") : t("web.settings.mcp_enable");
    toggle.setAttribute("aria-label", toggle.title);
    line.appendChild(toggle);
    const nameEl = el("span", "name", m.name);
    nameEl.title = m.name;
    line.appendChild(nameEl);
    line.appendChild(el("span", "st", m.status || "—"));
    line.appendChild(chip(t("web.settings.edit"), "", () => openMcpForm("edit", m)));
    line.appendChild(
      chip(t("web.settings.delete"), "danger", async () => {
        const r = await api<Dict>("/api/mcp/" + encodeURIComponent(m.id || m.name), {
          method: "DELETE",
        });
        if (r.ok && r.data && r.data.ok) {
          setIndicator(t("web.settings.mcp_saved"), false);
          await loadPlugins();
        } else {
          setIndicator((r.data && r.data.error) || t("web.settings.delete_failed"), true);
        }
      }),
    );
    list.appendChild(line);
  });
  if (settings.mcpForm) list.appendChild(mcpForm());
  if ((data.mcp || []).length) {
    const mnote = el("div", "settings-note");
    mnote.textContent = t("web.settings.mcp_note");
    list.appendChild(mnote);
  }
  renderLspSection(list, refreshLsp);
  container.appendChild(list);
  renderSections("plugins", PANEL_SECTIONS.plugins || []);
}

// Inline MCP add/edit form lives in `./mcp-form.js` (validation/error state is
// part of the form, not the panel). Secrets are never echoed by the API, so
// env/headers start blank — leaving them blank on edit keeps stored values.

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
