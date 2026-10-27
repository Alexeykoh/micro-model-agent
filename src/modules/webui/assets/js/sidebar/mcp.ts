// MCP tab for `mma web`: configured servers, their transport/target and a live
// enable toggle. The list is the same `config.mcpServers` view the settings
// panel uses (`GET /api/mcp`), so the two surfaces cannot diverge. Toggling is
// persisted now (`POST /api/mcp/:id`) but MCP connections are built on boot —
// the note below the list says a restart is needed.
import { api } from "../api.js";
import { el, makeToggle } from "../dom.js";
import { setIndicator } from "../dialog.js";
import { t } from "../i18n.js";
import { hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";

type McpRow = Dict & { id: string; name: string; status: string };

let rows: McpRow[] = [];
let loaded = false;
let loading = false;
let unavailable = false;

function bodyEl(): HTMLElement | null {
  return document.getElementById("mcpBody");
}

function on(row: McpRow): boolean {
  return row.status !== "disabled";
}

/** Цель соединения: URL для http/sse, команда для stdio. */
function target(row: McpRow): string {
  if (row.url) return String(row.url);
  const command = row.command ? String(row.command) : "";
  const args = Array.isArray(row.args) ? row.args.map(String).join(" ") : "";
  return [command, args].filter(Boolean).join(" ");
}

/** Явный переход в «Настройки → Плагины · MCP»: добавление/правка — там. */
function configureButton(): HTMLElement {
  const button = el("button", "linkbtn mcp-settings", t("web.mcp.open_settings"));
  button.type = "button";
  button.addEventListener("click", () => hooks.openSettingsAt?.("plugins", "settings-mcp"));
  return button;
}

function serverRow(row: McpRow): HTMLElement {
  const node = el("div", "mcpsrv");
  const enabled = on(row);
  const toggle = makeToggle(enabled, (next) => {
    row.status = next ? "enabled" : "disabled";
    row.enabled = next;
    void toggleServer(row, next);
    return true; // переключатель реагирует сразу, сервер — источник правды
  });
  toggle.title = t(enabled ? "web.mcp.disable" : "web.mcp.enable");
  toggle.setAttribute("aria-label", toggle.title);
  node.appendChild(toggle);

  const main = el("span", "mcpsrv-main");
  const title = el("span", "mcpsrv-name", row.name || row.id);
  main.appendChild(title);
  const meta = [row.transport, target(row)].filter(Boolean).join(" · ");
  if (meta) main.appendChild(el("span", "mcpsrv-meta", meta));
  node.appendChild(main);
  node.appendChild(
    el(
      "span",
      "mcpsrv-st " + (enabled ? "ok" : "dim"),
      t(enabled ? "web.mcp.state_on" : "web.mcp.state_off"),
    ),
  );
  return node;
}

export function renderMcp(): void {
  const host = bodyEl();
  if (!host) return;
  host.textContent = "";
  if (unavailable) {
    host.appendChild(el("div", "fdim", t("web.mcp.unavailable")));
    host.appendChild(configureButton());
    return;
  }
  if (!loaded) {
    host.appendChild(el("div", "fdim", t("web.mcp.loading")));
    return;
  }
  if (rows.length === 0) {
    host.appendChild(el("div", "fdim", t("web.mcp.empty")));
    host.appendChild(configureButton());
    return;
  }
  const active = rows.filter(on).length;
  host.appendChild(
    el(
      "div",
      "mcpsrv-summary",
      t("web.mcp.summary", {
        active: String(active),
        off: String(rows.length - active),
      }),
    ),
  );
  for (const row of rows) host.appendChild(serverRow(row));
  host.appendChild(el("div", "plg-hint", t("web.mcp.note")));
  host.appendChild(configureButton());
}

function adopt(payload: Dict): void {
  rows = Array.isArray(payload.mcp) ? (payload.mcp as McpRow[]) : [];
}

async function load(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const r = await api<Dict>("/api/mcp");
    if (!r.ok || !r.data) {
      unavailable = true;
      rows = [];
    } else {
      unavailable = false;
      adopt(r.data);
    }
    loaded = true;
  } catch {
    unavailable = true;
    rows = [];
    loaded = true;
  } finally {
    loading = false;
    renderMcp();
  }
}

async function toggleServer(row: McpRow, next: boolean): Promise<void> {
  const id = row.id || row.name;
  const r = await api<Dict>("/api/mcp/" + encodeURIComponent(id), {
    method: "POST",
    body: { enabled: next },
  });
  if (!r.ok || !r.data || r.data.ok !== true) {
    // Сервер отказал — возвращаем список к последней правде, а не к оптимизму.
    setIndicator(t("web.mcp.toggle_failed"), true);
    await load();
    return;
  }
  adopt(r.data);
  renderMcp();
}

export function sidebarMcpState(): void {
  if (document.getElementById("mcpBody")) {
    renderMcp();
    void load();
  }
}

/** SSE `plugins`: реестр/конфиг могли измениться из настроек. */
export function sidebarMcpEvent(): void {
  if (document.getElementById("pane-mcp")?.hidden === false) void load();
}
