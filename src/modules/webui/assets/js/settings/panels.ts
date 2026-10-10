// Generic settings rendering (registry-driven sections) + the bespoke panels
// (ui / security / memory / skills / plugins·MCP·LSP) and their loaders.
// Extracted from `settings.js`. Depends only downward: `settings/write.js`
// (write funnel), `settings/subdialog.js`, `settings/form.js`, controls.
import { el, icon, link, inlineTextNodes, makeToggle } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings, getPath, THEME_KEY } from "../store.js";
import { getUpdateInfo } from "../update-state.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { controlFor, PANEL_SECTIONS } from "./controls.js";
import { postConfig } from "./write.js";
import { openSubDialog, closeSubDialog } from "./subdialog.js";
import { mcpLiteralField, providerInput, providerSelect, providerCheck } from "./form.js";

// Localized label for a registry key: `config.key.<canonical>`, falling back
// to the raw key when no translation exists (so a new key is never blank).
export function configLabel(def: Dict): string {
  const k = "config.key." + def.key;
  const tr = t(k);
  return tr === k ? def.key : tr;
}

// Localized enum value: `config.enum.<value>`, falling back to the raw value.
// The raw value is still what gets POSTed — only the label is translated.
export function enumLabel(v: string): string {
  const k = "config.enum." + v;
  const tr = t(k);
  return tr === k ? v : tr;
}

export function defFor(key: string): Dict | null {
  return settings.registry.find((d) => d.key === key) || null;
}

export function row(label: string, control: string | Node | null, desc?: string): HTMLElement {
  const r = el("div", "row");
  const left = el("div", "row-label");
  left.appendChild(el("span", "row-name", label));
  if (desc) left.appendChild(el("span", "row-desc", desc));
  r.appendChild(left);
  if (typeof control === "string") {
    const v = el("span", "val", control);
    v.title = control;
    r.appendChild(v);
  } else if (control) {
    r.appendChild(control);
  }
  return r;
}

export function descFor(key: string): string {
  const k = "config.desc." + key;
  const d = t(k);
  return d === k ? "" : d;
}

// Names of configured providers, for `select` editors on provider-reference
// keys (`critic.provider`, `orchestrator.provider`). Prefers the `/api/providers`
// view; falls back to the live config's `provider.entries`.
function providerNameOptions(): string[] {
  const view: Dict = settings.providers || {};
  const cfgProvider: Dict = (settings.config && settings.config.provider) || {};
  const entries: Dict[] = Array.isArray(view.entries) && view.entries.length ? view.entries : Array.isArray(cfgProvider.entries) ? cfgProvider.entries : [];
  const names = entries.map((e) => e.label || e.type).filter((n): n is string => !!n);
  const active = view.active || cfgProvider.active;
  if (active && names.indexOf(active) === -1) names.unshift(active);
  return names;
}

// Generic per-type control (`settings/controls.js`): bool toggle, enum
// select, int/share/list/json inputs. `post` funnels through `postConfig`.
function configControl(def: Dict, key: string): HTMLElement {
  // Read-only keys carry their resolved value in the registry entry: the getter
  // is authoritative and may differ from the raw config field (`version`).
  const value =
    def.readOnly && def.value !== undefined
      ? def.value
      : settings.config
        ? getPath(settings.config, key)
        : undefined;
  return controlFor(def, value, {
    label: configLabel(def),
    enumLabel,
    emptyLabel: t("config.enum.none"),
    modelOptions: settings.models,
    providerOptions: providerNameOptions(),
    fieldLabel: (k: string) => {
      const kk = "config.field." + k;
      const tr = t(kk);
      return tr === kk ? k : tr;
    },
    post: (v: unknown) => void postConfig(key, v, false),
  });
}

// One titled section card: uppercase title + optional one-line explanation,
// then its setting rows. Titles come from PANEL_SECTIONS so a section name can
// never drift from the keys under it.
function sectionCard(section: Dict): HTMLElement {
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t(section.titleKey)));
  card.appendChild(head);
  if (section.descKey) {
    const d = t(section.descKey);
    if (d !== section.descKey) card.appendChild(el("div", "sec-desc", d));
  }
  const body = el("div", "sec-body");
  section.keys.forEach((key: string) => {
    const def = defFor(key);
    if (!def) return;
    body.appendChild(row(configLabel(def), configControl(def, key), descFor(def.key)));
  });
  card.appendChild(body);
  return card;
}

// Render the PANEL_SECTIONS table for a panel. Panels with custom bodies call
// this after their own content so bespoke widgets stay on top.
export function renderSections(panel: string, sections: Dict[]): void {
  const container = document.querySelector('[data-panel="' + panel + '"]');
  if (!container) return;
  sections.forEach((section) => container.appendChild(sectionCard(section)));
}

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
    setIndicator((r.data && r.data.error) || t("web.update.failed"), true);
    btn.removeAttribute("disabled");
    btn.textContent = t("web.update.install");
  }
}

// A titled group inside a settings panel (models / providers).
export function settingsSection(titleKey: string): { el: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const sec = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t(titleKey)));
  sec.appendChild(head);
  const body = el("div", "sec-body");
  sec.appendChild(body);
  return { el: sec, head, body };
}

// Compact action control used inside list items (use / edit / delete).
export function chip(label: string, cls: string | null, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", "chip" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function placeholderFor(data: unknown, empty: string): HTMLElement {
  const d = el("div", "placeholder");
  if (data === undefined) d.textContent = t("web.settings.loading");
  else d.textContent = empty;
  return d;
}

export function groupHeader(label: string, count?: number | null): HTMLElement {
  const head = el("div", "row");
  head.appendChild(el("span", "val accent", label));
  if (count != null) head.appendChild(el("span", "val dim", String(count)));
  return head;
}

// --- UI panel (mode + theme, browser-local) ------------------------------
const UI_THEME_KEY = "mma-ui-theme";

/** Color mode: dark | light | auto (browser-local). */
export function currentTheme(): string {
  return localStorage.getItem(THEME_KEY) || "auto";
}

/** UI theme: flat | console (browser-local; console is the default). */
export function currentUiTheme(): string {
  return localStorage.getItem(UI_THEME_KEY) || "console";
}

function renderUiPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="ui"]');
  if (!container) return;
  container.textContent = "";
  const segFor = (values: string[], current: () => string, onPick: (v: string) => void): HTMLElement => {
    const seg = el("span", "seg");
    values.forEach((value) => {
      const b = el("button", current() === value ? "on" : "", value);
      b.type = "button";
      b.setAttribute("aria-pressed", current() === value ? "true" : "false");
      b.addEventListener("click", () => onPick(value));
      seg.appendChild(b);
    });
    return seg;
  };
  // Mode (dark/light/auto) and theme (flat/console) are independent axes.
  const modeSeg = segFor(["dark", "light", "auto"], currentTheme, applyTheme);
  const themeSeg = segFor(["console", "flat"], currentUiTheme, applyUiTheme);
  // Both are browser-local preferences (localStorage), not config keys, so they
  // get their own card before the generated sections.
  const card = el("div", "settings-section");
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-title", t("web.settings.sec.ui.theme")));
  card.appendChild(head);
  const desc = t("web.settings.sec.ui.theme.desc");
  if (desc !== "web.settings.sec.ui.theme.desc") card.appendChild(el("div", "sec-desc", desc));
  const body = el("div", "sec-body");
  body.appendChild(row(t("web.settings.mode"), modeSeg));
  body.appendChild(row(t("web.settings.theme"), themeSeg));
  card.appendChild(body);
  container.appendChild(card);
  renderSections("ui", PANEL_SECTIONS.ui || []);
}

export function applyTheme(theme: string): void {
  localStorage.setItem(THEME_KEY, theme);
  const light = theme === "light" || (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.body.classList.toggle("light", !!light);
  renderUiPanel();
}

export function applyUiTheme(theme: string): void {
  localStorage.setItem(UI_THEME_KEY, theme);
  document.body.classList.toggle("console", theme === "console");
  renderUiPanel();
}

if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentTheme() === "auto") applyTheme("auto");
  });
}

// --- Security panel ------------------------------------------------------
function renderSecurityPanel(): void {
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
    row(t("web.settings.web_token"), el("span", "val dim", settings.webToken || t("web.settings.web_token_none")), t("config.desc.webToken")),
  );
  const note = el("div", "placeholder");
  note.appendChild(el("span", "tag", t("web.settings.terminal_tag")));
  note.appendChild(document.createTextNode(" " + t("web.settings.security_note")));
  body.appendChild(note);
  access.appendChild(body);
  container.appendChild(access);
}

// --- Memory panel --------------------------------------------------------
const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"];

/** Nested dialog: pick a memory category and write the note. */
function openMemoryForm(): void {
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const catSel = el("select");
  catSel.setAttribute("aria-label", t("web.settings.memory_category"));
  MEMORY_CATEGORIES.forEach((c) => catSel.appendChild(el("option", "", c)));
  catSel.value = "facts";
  grid.appendChild(mcpLiteralField(t("web.settings.memory_category"), catSel));
  box.appendChild(grid);
  const area = el("textarea");
  area.rows = 5;
  area.placeholder = t("web.settings.new_memory");
  area.value = "";
  box.appendChild(mcpLiteralField(t("web.settings.new_memory"), area));
  const actions = el("div", "pform-actions");
  actions.appendChild(
    link(t("web.settings.save"), "", async () => {
      const text = area.value.trim();
      if (!text) {
        area.focus();
        return;
      }
      const r = await api<Dict>("/api/memory", { method: "POST", body: { category: catSel.value, text } });
      if (r.ok && r.data && r.data.ok) {
        closeSubDialog();
        await loadMemory();
      } else {
        setIndicator(t("web.settings.add_failed"), true);
      }
    }),
  );
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  openSubDialog(t("web.settings.memory_add_title"), box, () => renderMemoryPanel());
}

function renderMemoryPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="memory"]');
  if (!container) return;
  container.textContent = "";
  if (settings.memory === undefined || settings.memory === null) {
    container.appendChild(placeholderFor(settings.memory, t("web.settings.memory_unavailable")));
    return;
  }
  const data = settings.memory;

  // Adding an entry opens the shared nested dialog: a category + a multi-line
  // note with room to write, instead of a cramped inline field.
  const addBtn = el("button", "sec-add");
  addBtn.type = "button";
  addBtn.appendChild(icon("plus"));
  addBtn.appendChild(el("span", "", t("web.settings.add")));
  addBtn.addEventListener("click", () => openMemoryForm());
  const addHead = el("div", "sec-head");
  addHead.appendChild(el("span", "sec-title", t("web.settings.sec.memory.add")));
  addHead.appendChild(addBtn);
  const addSec = el("div", "settings-section");
  addSec.appendChild(addHead);
  container.appendChild(addSec);

  const search = el("input", "searchbox");
  search.placeholder = t("web.settings.search_memory");
  search.setAttribute("aria-label", t("web.settings.search_memory"));
  container.appendChild(search);
  const list = el("div", "settings-list");
  container.appendChild(list);

  const categoryHeader = (label: string, count?: number | null) => {
    const head = el("div", "mem-cat");
    head.appendChild(el("span", "", label));
    if (count != null) head.appendChild(el("span", "n", String(count)));
    return head;
  };

  const entryBlock = (text: unknown, onForget?: () => void) => {
    const block = el("div", "mem-entry");
    const body = el("span", "mem-text");
    body.appendChild(inlineTextNodes(String(text == null ? "" : text)));
    body.title = String(text == null ? "" : text);
    block.appendChild(body);
    if (onForget) block.appendChild(link(t("web.settings.forget"), "mem-del", onForget));
    return block;
  };

  const draw = () => {
    list.textContent = "";
    const q = search.value.trim().toLowerCase();
    let any = false;
    (data.categories || []).forEach((cat: Dict) => {
      const entries = (cat.entries || []).filter(
        (e: Dict) => !q || String(e.text).toLowerCase().indexOf(q) !== -1,
      );
      if (!entries.length) return;
      any = true;
      list.appendChild(categoryHeader(cat.name, entries.length));
      entries.forEach((e: Dict) => {
        list.appendChild(
          entryBlock(e.text, async () => {
            const r = await api(
              "/api/memory/" + encodeURIComponent(cat.name) + "/" + e.n,
              { method: "DELETE" },
            );
            if (r.ok) await loadMemory();
            else setIndicator(t("web.settings.forget_failed"), true);
          }),
        );
      });
    });
    const prefs = Object.entries(data.preferences || {});
    if (prefs.length && !q) {
      any = true;
      list.appendChild(categoryHeader(t("web.settings.preferences"), prefs.length));
      prefs.forEach(([k, v]) => {
        list.appendChild(entryBlock(k + " = " + v));
      });
    }
    if (!any) {
      const empty = el("div", "placeholder");
      empty.textContent = q ? t("web.settings.no_matches") : t("web.settings.no_memory");
      list.appendChild(empty);
    }
  };
  search.addEventListener("input", draw);
  draw();
}

// --- Skills panel --------------------------------------------------------
function renderSkillsPanel(): void {
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
  const list = el("div", "settings-list");
  settings.skills.forEach((s: Dict) => {
    const item = el("div", "skill-item");
    const head = el("div", "skill-head");
    head.appendChild(el("span", s.enabled ? "g" : "dim", s.enabled ? "✓" : "○"));
    const nameEl = el("span", "name", s.name);
    nameEl.title = s.name;
    head.appendChild(nameEl);
    head.appendChild(el("span", "st", s.enabled ? t("web.settings.enabled") : t("web.settings.available")));
    item.appendChild(head);
    if (s.source) {
      const src = el("div", "skill-src", s.source);
      src.title = s.source;
      item.appendChild(src);
    }
    list.appendChild(item);
  });
  container.appendChild(list);
}

// --- Plugins / MCP / LSP panel -------------------------------------------
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
    parts.push(t("web.plugins.reload_skills", {
      added: String(skills.added ?? 0),
      removed: String(skills.removed ?? 0),
    }));
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

function renderPluginsPanel(): void {
  const container = document.querySelector<HTMLElement>('[data-panel="plugins"]');
  if (!container) return;
  container.textContent = "";
  if (settings.pluginsData === undefined || settings.pluginsData === null) {
    container.appendChild(placeholderFor(settings.pluginsData, t("web.settings.plugins_unavailable")));
    return;
  }
  const data = settings.pluginsData;
  const list = el("div", "settings-list");
  list.appendChild(groupHeader(t("web.settings.plugins_header"), (data.plugins || []).length));
  if (!(data.plugins || []).length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_plugins");
    list.appendChild(empty);
  }
  (data.plugins || []).forEach((p: Dict) => {
    const line = el("div", "list-line");
    line.appendChild(el("span", "g", p.enabled === false ? "–" : "✓"));
    const nameEl = el("span", "name", p.name);
    nameEl.title = p.name;
    line.appendChild(nameEl);
    if (p.version) line.appendChild(el("span", "src", "v" + p.version));
    if (p.source) {
      const src = el("span", "src", p.source);
      src.title = p.source;
      line.appendChild(src);
    }
    if (p.builtin) line.appendChild(el("span", "src", t("web.settings.builtin")));
    // Живой тумблер вместо статуса: тот же контракт, что у строки MCP ниже.
    // `onFlip` ничего не возвращает — состояние перерисовывается из ответа.
    line.appendChild(
      makeToggle(p.enabled !== false, () => {
        void togglePlugin(p.name, p.enabled === false);
      }),
    );
    list.appendChild(line);
  });
  const pnote = el("div", "settings-note");
  pnote.textContent = t("web.settings.plugins_note");
  list.appendChild(pnote);
  const reloadBtn = el("button", "sec-add");
  reloadBtn.type = "button";
  reloadBtn.appendChild(icon("refresh"));
  reloadBtn.appendChild(el("span", "", t("web.plugins.reload")));
  reloadBtn.addEventListener("click", () => void reloadPlugins());
  list.appendChild(reloadBtn);

  list.appendChild(groupHeader(t("web.settings.mcp_servers"), (data.mcp || []).length));
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
    line.appendChild(chip(t("web.settings.delete"), "danger", async () => {
      const r = await api<Dict>("/api/mcp/" + encodeURIComponent(m.id || m.name), { method: "DELETE" });
      if (r.ok && r.data && r.data.ok) {
        setIndicator(t("web.settings.mcp_saved"), false);
        await loadPlugins();
      } else {
        setIndicator((r.data && r.data.error) || t("web.settings.delete_failed"), true);
      }
    }));
    list.appendChild(line);
  });
  if (settings.mcpForm) list.appendChild(mcpForm());
  if ((data.mcp || []).length) {
    const mnote = el("div", "settings-note");
    mnote.textContent = t("web.settings.mcp_note");
    list.appendChild(mnote);
  }
  renderLspSection(list);
  container.appendChild(list);
  renderSections("plugins", PANEL_SECTIONS.plugins || []);
}

// Inline MCP add/edit form. Secrets are never echoed by the API, so env/headers
// start blank — leaving them blank on edit keeps the stored values (patch
// semantics: absent keys are not touched).
function mcpForm(): HTMLElement {
  const mode = (settings.mcpForm && settings.mcpForm.mode) || "add";
  const editing: Dict = (settings.mcpForm && settings.mcpForm.entry) || {};
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const fName = providerInput(editing.name || "", "text", "my-server");
  const fTransport = providerSelect(["stdio", "sse", "http"], editing.transport || "stdio");
  const fCommand = providerInput(editing.command || "", "text", "npx");
  const fUrl = providerInput(editing.url || "", "text", "https://…");
  grid.appendChild(mcpLiteralField("name", fName));
  grid.appendChild(mcpLiteralField("transport", fTransport));
  grid.appendChild(mcpLiteralField("command", fCommand));
  grid.appendChild(mcpLiteralField("url", fUrl));
  box.appendChild(grid);
  const adv = el("details", "pform-adv");
  adv.appendChild(el("summary", "", t("web.settings.provider_advanced")));
  const fArgs = providerInput(editing.args ? JSON.stringify(editing.args) : "", "text", '["--stdio"]');
  const fTimeout = providerInput(editing.timeout != null ? String(editing.timeout) : "", "number", "30000");
  const fEnabled = providerCheck(editing.enabled !== false);
  adv.appendChild(mcpLiteralField("args (JSON)", fArgs));
  adv.appendChild(mcpLiteralField("timeout (ms)", fTimeout));
  const envKeys = Array.isArray(editing.envKeys) ? editing.envKeys : [];
  const headerKeys = Array.isArray(editing.headerKeys) ? editing.headerKeys : [];
  const fEnv = el("textarea");
  fEnv.placeholder = envKeys.length ? "stored: " + envKeys.join(", ") + " — blank keeps" : '{"TOKEN": "…"}';
  const fHeaders = el("textarea");
  fHeaders.placeholder = headerKeys.length ? "stored: " + headerKeys.join(", ") + " — blank keeps" : '{"Authorization": "…"}';
  adv.appendChild(mcpLiteralField("env (JSON)", fEnv));
  adv.appendChild(mcpLiteralField("headers (JSON)", fHeaders));
  adv.appendChild(mcpLiteralField("enabled", fEnabled));
  box.appendChild(adv);
  const f: Dict = { name: fName, transport: fTransport, command: fCommand, url: fUrl, args: fArgs, timeout: fTimeout, env: fEnv, headers: fHeaders, enabled: fEnabled };
  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", () => void submitMcpForm(f, mode, editing)));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
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

function parseJsonMap(raw: string): { present: boolean; value: Dict | null } {
  const text = raw.trim();
  if (!text) return { present: false, value: null };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: true, value: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: true, value: null };
  if (!Object.values(parsed).every((v) => typeof v === "string")) return { present: true, value: null };
  return { present: true, value: parsed as Dict };
}

async function submitMcpForm(f: Dict, mode: string, editing: Dict): Promise<void> {
  const name = f.name.value.trim();
  const transport = f.transport.value || "stdio";
  const command = f.command.value.trim();
  const url = f.url.value.trim();
  if (!name || (transport === "stdio" ? !command : !url)) {
    setIndicator(t("web.settings.mcp_required"), true);
    return;
  }
  const body: Dict = { name, transport };
  if (command) body.command = command;
  if (url) body.url = url;
  const argsRaw = f.args.value.trim();
  if (argsRaw) {
    let args: unknown = null;
    try {
      args = JSON.parse(argsRaw);
    } catch {
      args = null;
    }
    if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
      setIndicator(t("web.settings.mcp_invalid"), true);
      return;
    }
    body.args = args;
  }
  for (const key of ["env", "headers"]) {
    const parsed = parseJsonMap(f[key].value);
    if (parsed.present && !parsed.value) {
      setIndicator(t("web.settings.mcp_invalid"), true);
      return;
    }
    if (parsed.present) body[key] = parsed.value;
  }
  const timeoutRaw = f.timeout.value.trim();
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isInteger(n) || n < 1000 || n > 300000) {
      setIndicator(t("web.settings.mcp_invalid"), true);
      return;
    }
    body.timeout = n;
  }
  body.enabled = f.enabled.checked;
  const target = mode === "edit" ? "/api/mcp/" + encodeURIComponent(editing.id || editing.name) : "/api/mcp";
  const r = await api<Dict>(target, { method: mode === "edit" ? "PUT" : "POST", body });
  if (r.ok && r.data && r.data.ok) {
    setIndicator(t("web.settings.mcp_saved"), false);
    closeSubDialog();
  } else {
    setIndicator((r.data && r.data.error) || t("web.settings.save_failed"), true);
  }
}

function renderLspSection(list: HTMLElement): void {
  const servers = settings.lsp;
  list.appendChild(groupHeader(t("web.settings.lsp_servers"), Array.isArray(servers) ? servers.length : null));
  if (servers === undefined || servers === null) {
    list.appendChild(placeholderFor(servers, t("web.settings.lsp_unavailable")));
    return;
  }
  if (!servers.length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_lsp");
    list.appendChild(empty);
  }
  servers.forEach((entry: Dict) => {
    const line = el("div", "list-line");
    line.appendChild(el("span", entry.enabled ? "g" : "dim", entry.enabled ? "✓" : "○"));
    const nameEl = el("span", "name", entry.lang);
    nameEl.title = entry.lang;
    line.appendChild(nameEl);
    const meta = [entry.command, entry.timeout != null ? entry.timeout + " ms" : null].filter(Boolean).join(" · ");
    if (meta) line.appendChild(el("span", "src", meta));
    line.appendChild(el("span", "st", entry.enabled ? t("web.settings.enabled") : t("web.settings.disabled")));
    line.appendChild(chip(t("web.settings.edit"), "", () => openLspForm(entry)));
    list.appendChild(line);
  });
  if (servers.length) {
    const note = el("div", "settings-note");
    note.textContent = t("web.settings.lsp_note");
    list.appendChild(note);
  }
}

/** Open the LSP server edit nested dialog. */
function openLspForm(entry: Dict): void {
  settings.lspForm = { lang: entry.lang, entry };
  openSubDialog(entry.lang, lspForm(), () => {
    settings.lspForm = null;
    renderPluginsPanel();
    void loadLsp();
  });
}

// LSP server edit form (enabled toggle, timeout, command, args JSON).
function lspForm(): HTMLElement {
  const editing: Dict = (settings.lspForm && settings.lspForm.entry) || {};
  const lang = (settings.lspForm && settings.lspForm.lang) || editing.lang || "";
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const fCommand = providerInput(editing.command || "", "text", "npx");
  const fTimeout = providerInput(editing.timeout != null ? String(editing.timeout) : "", "number", "30000");
  const fEnabled = providerCheck(editing.enabled !== false);
  grid.appendChild(mcpLiteralField("command", fCommand));
  grid.appendChild(mcpLiteralField("timeout (ms)", fTimeout));
  grid.appendChild(mcpLiteralField("enabled", fEnabled));
  box.appendChild(grid);
  const fArgs = el("textarea");
  fArgs.value = editing.args ? JSON.stringify(editing.args) : "";
  fArgs.placeholder = '["--stdio"]';
  box.appendChild(mcpLiteralField("args (JSON)", fArgs));
  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", async () => {
    const body: Dict = {};
    const command = fCommand.value.trim();
    if (command) body.command = command;
    const timeoutRaw = fTimeout.value.trim();
    if (timeoutRaw) {
      const n = Number(timeoutRaw);
      if (!Number.isInteger(n) || n < 1000 || n > 300000) {
        setIndicator(t("web.settings.provider_invalid"), true);
        return;
      }
      body.timeout = n;
    }
    const argsRaw = fArgs.value.trim();
    if (argsRaw) {
      let args: unknown = null;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = null;
      }
      if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
        setIndicator(t("web.settings.provider_invalid"), true);
        return;
      }
      body.args = args;
    }
    body.enabled = fEnabled.checked;
    const r = await api<Dict>("/api/lsp/" + encodeURIComponent(lang), { method: "PUT", body });
    if (r.ok && r.data && r.data.ok) {
      setIndicator(t("web.settings.mcp_saved"), false);
      closeSubDialog();
    } else {
      setIndicator((r.data && r.data.error) || t("web.settings.save_failed"), true);
    }
  }));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
}

// --- loaders -------------------------------------------------------------
export async function loadLsp(): Promise<void> {
  const r = await api<{ servers?: Dict[] }>("/api/lsp");
  settings.lsp = r.ok && r.data && Array.isArray(r.data.servers) ? r.data.servers : null;
  renderPluginsPanel();
}

export async function loadMemory(): Promise<void> {
  const r = await api<Dict>("/api/memory");
  settings.memory = r.ok && r.data ? r.data : null;
  renderMemoryPanel();
}

export async function loadSkills(): Promise<void> {
  const r = await api<{ skills?: Dict[] }>("/api/skills");
  settings.skills = r.ok && r.data && Array.isArray(r.data.skills) ? r.data.skills : null;
  renderSkillsPanel();
}

export async function loadPlugins(): Promise<void> {
  const r = await api<Dict>("/api/plugins");
  settings.pluginsData =
    r.ok && r.data
      ? { plugins: r.data.plugins || [], mcp: r.data.mcp || [] }
      : null;
  renderPluginsPanel();
}

// Panel renderers used by the settings shell's `renderSettings`.
export { renderUiPanel, renderMemoryPanel, renderSkillsPanel, renderPluginsPanel, renderSecurityPanel };
