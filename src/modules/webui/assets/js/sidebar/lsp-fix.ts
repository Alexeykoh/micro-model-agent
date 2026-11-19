// "Fix" affordance for LSP diagnostics: turn the listed problems into one agent
// prompt and hand it to the composer (via `hooks.askAgent`). Kept out of the
// two LSP sections so the prompt shape and the button stay identical.
import { el, icon } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { hooks } from "../store.js";

const MAX_PROBLEMS = 50;

/** Human-readable diagnostics block: `line:col [severity] message`. */
export function formatDiagnostics(diags: Dict[]): string {
  return diags
    .slice(0, MAX_PROBLEMS)
    .map((d) => {
      const line = Number(d.line) || 1;
      const col = Number(d.column) || 1;
      const sev = String(d.severity || "info");
      const msg = String(d.message || "").replace(/\s*\n\s*/g, " ");
      return `- ${line}:${col} [${sev}] ${msg}`;
    })
    .join("\n");
}

/** Prompt asking the agent to repair the diagnostics and verify with LSP. */
export function fixPrompt(path: string, diags: Dict[]): string {
  return t("web.sidebar.lsp_fix_prompt", {
    path,
    problems: formatDiagnostics(diags),
  });
}

/** Sends `diags` for `path` to the agent; no-op when there is nothing to fix. */
export function fixDiagnostics(path: string, diags: Dict[]): void {
  if (!path || diags.length === 0) return;
  hooks.askAgent?.(fixPrompt(path, diags));
}

/** Localized "fix" button wired to `fixDiagnostics`. */
export function fixButton(path: string, diags: Dict[]): HTMLButtonElement {
  const btn = el("button", "lsp-file-go lsp-fix") as HTMLButtonElement;
  btn.type = "button";
  const label = t("web.sidebar.lsp_fix");
  btn.title = t("web.sidebar.lsp_fix_title", { path });
  btn.setAttribute("aria-label", btn.title);
  btn.appendChild(icon("wrench"));
  btn.appendChild(document.createTextNode(label));
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    fixDiagnostics(path, diags);
  });
  return btn;
}
