// MCP add/edit form (nested dialog). Extracted from `panels.ts` so the panel
// stays under its size ceiling and the form owns its own validation/error state.
//
// UX contract (B-37): validation errors render inside the form next to Save
// (aria-live), `command`/`url` are shown per transport, and transport is a real
// choice with no empty option.
import { el, link } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { setIndicator } from "../dialog.js";
import { closeSubDialog } from "./subdialog.js";
import { mcpLiteralField, providerInput, providerSelect, providerCheck } from "./form.js";

/** Transports accepted by the server (`MCP_TRANSPORTS` in settings-api). */
const TRANSPORTS = ["stdio", "sse", "http"] as const;

interface McpFields {
  name: HTMLInputElement;
  transport: HTMLSelectElement;
  command: HTMLInputElement;
  url: HTMLInputElement;
  args: HTMLInputElement;
  timeout: HTMLInputElement;
  env: HTMLTextAreaElement;
  headers: HTMLTextAreaElement;
  enabled: HTMLInputElement;
}

/** Read an MCP field's trimmed value. */
function val(input: HTMLInputElement | HTMLTextAreaElement): string {
  return input.value.trim();
}

/** Inline form error writer (cleared on the next edit). */
function errorWriter(box: HTMLElement): (msg: string) => void {
  const node = el("div", "pform-error");
  node.setAttribute("role", "alert");
  node.setAttribute("aria-live", "polite");
  node.hidden = true;
  box.appendChild(node);
  return (msg: string) => {
    node.textContent = msg;
    node.hidden = false;
  };
}

/** Inline MCP add/edit form body, rendered inside the nested dialog. */
export function mcpForm(): HTMLElement {
  const mode = (settings.mcpForm && settings.mcpForm.mode) || "add";
  const editing: Dict = (settings.mcpForm && settings.mcpForm.entry) || {};
  const box = el("div", "pform");
  const grid = el("div", "pform-grid");
  const f: McpFields = {
    name: providerInput(editing.name || "", "text", "my-server"),
    transport: providerSelect([...TRANSPORTS], editing.transport || "stdio", false),
    command: providerInput(editing.command || "", "text", "npx"),
    url: providerInput(editing.url || "", "text", "https://…"),
    args: providerInput(editing.args ? JSON.stringify(editing.args) : "", "text", '["--stdio"]'),
    timeout: providerInput(editing.timeout != null ? String(editing.timeout) : "", "number", "30000"),
    env: el("textarea"),
    headers: el("textarea"),
    enabled: providerCheck(editing.enabled !== false),
  };
  const nameField = mcpLiteralField(t("web.settings.mcp_field_name"), f.name, "name");
  const transportField = mcpLiteralField(
    t("web.settings.mcp_field_transport"),
    f.transport,
    "transport",
  );
  const commandField = mcpLiteralField(
    t("web.settings.mcp_field_command"),
    f.command,
    "command",
  );
  const urlField = mcpLiteralField(t("web.settings.mcp_field_url"), f.url, "url");
  grid.appendChild(nameField);
  grid.appendChild(transportField);
  grid.appendChild(commandField);
  grid.appendChild(urlField);
  box.appendChild(grid);

  const adv = el("details", "pform-adv");
  adv.appendChild(el("summary", "", t("web.settings.provider_advanced")));
  const envKeys = Array.isArray(editing.envKeys) ? editing.envKeys : [];
  const headerKeys = Array.isArray(editing.headerKeys) ? editing.headerKeys : [];
  f.env.placeholder = envKeys.length ? "stored: " + envKeys.join(", ") + " — blank keeps" : '{"TOKEN": "…"}';
  f.headers.placeholder = headerKeys.length ? "stored: " + headerKeys.join(", ") + " — blank keeps" : '{"Authorization": "…"}';
  adv.appendChild(mcpLiteralField(t("web.settings.mcp_field_args"), f.args, "args"));
  adv.appendChild(mcpLiteralField(t("web.settings.mcp_field_timeout"), f.timeout, "timeout"));
  adv.appendChild(mcpLiteralField(t("web.settings.mcp_field_env"), f.env, "env"));
  adv.appendChild(mcpLiteralField(t("web.settings.mcp_field_headers"), f.headers, "headers"));
  adv.appendChild(mcpLiteralField(t("web.settings.mcp_field_enabled"), f.enabled, "enabled"));
  box.appendChild(adv);

  // Only the field that transport actually uses is visible; advanced fields
  // stay where they are (`<details>`). No empty transport exists in the select.
  const syncTransport = (): void => {
    const stdio = f.transport.value === "stdio";
    commandField.hidden = !stdio;
    urlField.hidden = stdio;
  };
  f.transport.addEventListener("change", syncTransport);
  syncTransport();

  const showError = errorWriter(box);
  const clearError = (): void => {
    const node = box.querySelector<HTMLElement>(".pform-error");
    if (node) {
      node.hidden = true;
      node.textContent = "";
    }
  };
  box.addEventListener("input", clearError);
  box.addEventListener("change", clearError);

  const actions = el("div", "pform-actions");
  actions.appendChild(link(t("web.settings.save"), "", () => void submitMcpForm(f, mode, editing, showError)));
  actions.appendChild(link(t("web.settings.cancel"), "dim", () => closeSubDialog()));
  box.appendChild(actions);
  return box;
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

async function submitMcpForm(
  f: McpFields,
  mode: string,
  editing: Dict,
  showError: (msg: string) => void,
): Promise<void> {
  const name = val(f.name);
  const transport = f.transport.value;
  // Never send an empty transport. The select has no empty option, but a
  // hand-edited/legacy DOM value must be rejected explicitly, not guessed.
  if (!(TRANSPORTS as readonly string[]).includes(transport)) {
    showError(t("web.settings.mcp_transport_required"));
    return;
  }
  const command = val(f.command);
  const url = val(f.url);
  if (!name || (transport === "stdio" ? !command : !url)) {
    showError(t("web.settings.mcp_required"));
    return;
  }
  const body: Dict = { name, transport };
  if (transport === "stdio") body.command = command;
  else body.url = url;
  const argsRaw = val(f.args);
  if (argsRaw) {
    let args: unknown = null;
    try {
      args = JSON.parse(argsRaw);
    } catch {
      args = null;
    }
    if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
      showError(t("web.settings.mcp_invalid"));
      return;
    }
    body.args = args;
  }
  for (const key of ["env", "headers"] as const) {
    const parsed = parseJsonMap(f[key].value);
    if (parsed.present && !parsed.value) {
      showError(t("web.settings.mcp_invalid"));
      return;
    }
    if (parsed.present) body[key] = parsed.value;
  }
  const timeoutRaw = val(f.timeout);
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    if (!Number.isInteger(n) || n < 1000 || n > 300000) {
      showError(t("web.settings.mcp_invalid"));
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
    showError((r.data && String(r.data.error)) || t("web.settings.save_failed"));
  }
}
