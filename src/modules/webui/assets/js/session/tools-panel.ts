// Per-session tools panel next to the speed chip. Shows the exact set that will
// reach the LLM schema, with a manual on/off override for each tool and a
// client-side search. State is keyed by the active session on the server.
import { api } from "../api.js";
import { el, icon, makeToggle } from "../dom.js";
import { t } from "../i18n.js";
import { openSubDialog } from "../subdialog.js";
import { session } from "../store.js";
import type { Dict } from "../core/store/types.js";

interface ToolView {
  name: string;
  description?: string;
  tags?: string[];
  alwaysOn?: boolean;
  enabled: boolean;
  override: "on" | "off" | null;
}

interface ToolsResponse {
  ok?: boolean;
  sessionId?: string;
  tools?: ToolView[];
  error?: string;
}

let btnBound = false;
let openSession: string | null = null;
let tools: ToolView[] = [];
let query = "";
let filter = "all";
let listHost: HTMLElement | null = null;
let countHost: HTMLElement | null = null;
let chipsHost: HTMLElement | null = null;

function toolsBtn(): HTMLElement | null {
  return document.getElementById("toolsBtn");
}

/** Mounts the wrench button and one click handler (idempotent on boot). */
export function initToolsPanel(): void {
  const btn = toolsBtn();
  if (!btn) return;
  if (!btn.firstChild) btn.appendChild(icon("wrench"));
  btn.title = t("web.tools.title");
  btn.setAttribute("aria-label", t("web.tools.title"));
  btn.hidden = false;
  if (btnBound) return;
  btnBound = true;
  btn.addEventListener("click", () => void openToolsPanel());
}

function statusText(tool: ToolView): string {
  if (tool.override === "on") return t("web.tools.forced_on");
  if (tool.override === "off") return t("web.tools.forced_off");
  return tool.enabled ? t("web.tools.on") : t("web.tools.off");
}

function matches(tool: ToolView): boolean {
  const tags = tool.tags ?? [];
  if (filter !== "all" && !tags.includes(filter)) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [tool.name, tool.description ?? "", ...tags]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

/** Tag counts for the filter chips (`all` first, then alphabetical). */
function filterChips(): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    for (const tag of tool.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderChips(): void {
  if (!chipsHost) return;
  chipsHost.textContent = "";
  const chip = (id: string, label: string) => {
    const btn = el("button", "tools-chip" + (filter === id ? " on" : ""), label);
    btn.type = "button";
    btn.setAttribute("aria-pressed", filter === id ? "true" : "false");
    btn.addEventListener("click", () => {
      filter = id;
      renderChips();
      renderList();
    });
    chipsHost!.appendChild(btn);
  };
  chip("all", `${t("web.tools.all")} ${tools.length}`);
  for (const [tag, count] of filterChips()) chip(tag, `${tag} ${count}`);
}

function renderList(): void {
  if (!listHost) return;
  const shown = tools.filter(matches).sort((a, b) => a.name.localeCompare(b.name));
  const on = tools.filter((tool) => tool.enabled).length;
  if (countHost) {
    countHost.textContent = t("web.tools.count", { on, total: tools.length });
  }
  listHost.textContent = "";
  if (shown.length === 0) {
    listHost.appendChild(el("div", "tools-empty", t("web.tools.no_match")));
    return;
  }
  for (const tool of shown) {
    const row = el("div", "tools-row");
    const main = el("div", "tools-main");
    main.appendChild(el("span", "tools-name", tool.name));
    if (tool.tags?.length) main.appendChild(el("span", "tools-tags", tool.tags.join(" · ")));
    if (tool.description) {
      const d = el("span", "tools-desc", tool.description);
      d.title = tool.description;
      main.appendChild(d);
    }
    row.appendChild(main);
    row.appendChild(el("span", "tools-state" + (tool.enabled ? " on" : ""), statusText(tool)));
    const toggle = makeToggle(tool.enabled, (next) => {
      void flip(tool.name, next);
      return true;
    });
    toggle.title = t(tool.enabled ? "web.tools.disable" : "web.tools.enable", { name: tool.name });
    row.appendChild(toggle);
    listHost.appendChild(row);
  }
}

async function load(sessionId: string): Promise<void> {
  const r = await api<ToolsResponse>("/api/tools?session=" + encodeURIComponent(sessionId));
  if (!r.ok || !r.data?.ok) {
    const reason = r.data?.error || String(r.status || "unavailable");
    if (listHost) {
      listHost.textContent = "";
      listHost.appendChild(el("div", "tools-empty", t("web.tools.unavailable", { reason })));
    }
    if (countHost) countHost.textContent = "";
    return;
  }
  tools = Array.isArray(r.data.tools) ? r.data.tools : [];
  renderChips();
  renderList();
}

async function flip(name: string, enabled: boolean): Promise<void> {
  if (!openSession) return;
  const r = await api<ToolsResponse>("/api/tools", {
    method: "POST",
    body: { sessionId: openSession, name, enabled },
  });
  if (!r.ok || !r.data?.ok) {
    // Paint server truth again: the toggle flipped optimistically.
    await load(openSession);
    return;
  }
  tools = Array.isArray(r.data.tools) ? r.data.tools : tools;
  renderChips();
  renderList();
}

/** Opens the panel for the active tab's session. */
export async function openToolsPanel(): Promise<void> {
  const sid = session.activeSessionId;
  openSession = sid || null;
  tools = [];
  query = "";
  filter = "all";
  const box = el("div", "tools-panel");
  const head = el("div", "tools-head");
  countHost = el("span", "tools-count", "");
  head.appendChild(countHost);
  const search = el("input", "tools-search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = t("web.tools.search");
  search.setAttribute("aria-label", t("web.tools.search"));
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });
  head.appendChild(search);
  box.appendChild(head);
  chipsHost = el("div", "tools-filters");
  box.appendChild(chipsHost);
  listHost = el("div", "tools-list");
  box.appendChild(listHost);
  openSubDialog(t("web.tools.title"), box);
  if (!openSession) {
    listHost.appendChild(el("div", "tools-empty", t("web.tools.no_session")));
    return;
  }
  listHost.appendChild(el("div", "tools-empty", t("web.tools.loading")));
  await load(openSession);
}
