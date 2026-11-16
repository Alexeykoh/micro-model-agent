// MCP servers sub-tab of the Plugins panel: list, live toggle, add/edit/delete.
// Split out of `panels-plugins.ts` so each file stays under the 300-line rule.
import { el, icon, makeToggle } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { chip, settingsSection } from "./panels-shared.js";
import { mcpForm } from "./mcp-form.js";

export interface McpSectionDeps {
  /** Open the shared add/edit sub-dialog (owned by the panel shell). */
  openForm: (mode: string, entry: Dict | null) => void;
  /** Re-read the plugin/MCP registry after a mutation. */
  reload: () => Promise<void> | void;
}

export function renderMcpSection(pane: HTMLElement, data: Dict, deps: McpSectionDeps): void {
  const servers = (data.mcp || []) as Dict[];
  const section = settingsSection("web.settings.mcp_servers");
  section.el.id = "settings-mcp";
  section.head.appendChild(el("span", "sec-count", String(servers.length)));

  const addBtn = el("button", "sec-add");
  addBtn.type = "button";
  addBtn.appendChild(icon("plus"));
  addBtn.appendChild(el("span", "", t("web.settings.mcp_add")));
  addBtn.addEventListener("click", () => deps.openForm("add", null));
  section.head.appendChild(addBtn);

  if (!servers.length) {
    const empty = el("div", "placeholder");
    empty.textContent = t("web.settings.no_mcp");
    section.body.appendChild(empty);
  }
  servers.forEach((m: Dict) => {
    const line = el("div", "list-line");
    const on = m.status !== "disabled";
    const toggle = makeToggle(on, (next) => {
      void api<Dict>("/api/mcp/" + encodeURIComponent(m.id || m.name), {
        method: "POST",
        body: { enabled: next },
      }).then(async (r) => {
        if (r.ok && r.data && r.data.ok) {
          setIndicator(t("web.settings.mcp_saved"), false);
          await deps.reload();
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
    line.appendChild(chip(t("web.settings.edit"), "", () => deps.openForm("edit", m)));
    line.appendChild(
      chip(t("web.settings.delete"), "danger", async () => {
        const r = await api<Dict>("/api/mcp/" + encodeURIComponent(m.id || m.name), {
          method: "DELETE",
        });
        if (r.ok && r.data && r.data.ok) {
          setIndicator(t("web.settings.mcp_saved"), false);
          await deps.reload();
        } else {
          setIndicator((r.data && r.data.error) || t("web.settings.delete_failed"), true);
        }
      }),
    );
    section.body.appendChild(line);
  });
  if (settings.mcpForm) section.body.appendChild(mcpForm());
  if (servers.length) {
    const note = el("div", "settings-note");
    note.textContent = t("web.settings.mcp_note");
    section.body.appendChild(note);
  }
  pane.appendChild(section.el);
}
