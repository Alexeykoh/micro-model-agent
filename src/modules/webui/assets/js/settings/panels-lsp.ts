// LSP servers section inside the plugins panel + the server edit dialog.
// Extracted from `panels.ts` (rule 6). The refresh after an edit is passed in
// by the panel owner (`panels-plugins.ts`) so this module stays a leaf and the
// frontend graph has no cycle.
import { el, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { groupHeader, placeholderFor, chip } from "./panels-shared.js";
import { openSubDialog, closeSubDialog } from "./subdialog.js";
import { mcpLiteralField, providerInput, providerCheck } from "./form.js";

export function renderLspSection(list: HTMLElement, onChange: () => void): void {
  const servers = settings.lsp;
  list.appendChild(
    Object.assign(
      groupHeader(t("web.settings.lsp_servers"), Array.isArray(servers) ? servers.length : null),
      { id: "settings-lsp" },
    ),
  );
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
    const meta = [entry.command, entry.timeout != null ? entry.timeout + " ms" : null]
      .filter(Boolean)
      .join(" · ");
    if (meta) line.appendChild(el("span", "src", meta));
    line.appendChild(
      el("span", "st", entry.enabled ? t("web.settings.enabled") : t("web.settings.disabled")),
    );
    line.appendChild(chip(t("web.settings.edit"), "", () => openLspForm(entry, onChange)));
    list.appendChild(line);
  });
  if (servers.length) {
    const note = el("div", "settings-note");
    note.textContent = t("web.settings.lsp_note");
    list.appendChild(note);
  }
}

/** Open the LSP server edit nested dialog. */
function openLspForm(entry: Dict, onChange: () => void): void {
  settings.lspForm = { lang: entry.lang, entry };
  openSubDialog(entry.lang, lspForm(), () => {
    settings.lspForm = null;
    onChange();
  });
}

// LSP server edit form (enabled toggle, timeout, command, args JSON).
function lspForm(): HTMLElement {
  const editing: Dict = (settings.lspForm && settings.lspForm.entry) || {};
  const lang = (settings.lspForm && settings.lspForm.lang) || editing.lang || "";
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const fCommand = providerInput(editing.command || "", "text", "npx");
  const fTimeout = providerInput(
    editing.timeout != null ? String(editing.timeout) : "",
    "number",
    "30000",
  );
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
  actions.appendChild(
    link(t("web.settings.save"), "", async () => {
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
    }),
  );
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
}
