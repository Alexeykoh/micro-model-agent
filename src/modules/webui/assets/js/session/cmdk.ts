// Slash-command autocomplete for the composer. Extracted from `tabs.js`.
// Leaf: the composer supplies textarea autogrow via `initCmdk`, so this module
// never imports upward.
import { el, inp } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import type { Dict } from "../core/store/types.js";

// List comes from the server (`/api/commands`) so it stays in sync with `/help`.
const cmdk = el("div", "cmdk");
cmdk.id = "cmdk-list";
cmdk.hidden = true;
cmdk.setAttribute("role", "listbox");
const inputArea = document.querySelector(".input-area");
if (inputArea) inputArea.appendChild(cmdk);
let webCommands: Dict[] = [];
let cmdkItems: Dict[] = [];
let cmdkIndex = 0;

let autogrowFn: () => void = () => {};

/** Composer supplies the textarea autogrow; keeps this module a leaf. */
export function initCmdk(deps: { autogrow?: () => void } | null): void {
  if (deps && typeof deps.autogrow === "function") autogrowFn = deps.autogrow;
}

export async function loadCommands(): Promise<void> {
  const r = await api<{ commands?: Dict[] }>("/api/commands");
  if (r.ok && r.data && Array.isArray(r.data.commands)) webCommands = r.data.commands;
}

function slashToken(): string | null {
  const v = inp.value;
  return v.startsWith("/") && !/\s/.test(v) ? v : null;
}

export function isCmdkOpen(): boolean {
  return !cmdk.hidden;
}

export function closeCmdk(): void {
  if (cmdk.hidden) return;
  cmdk.hidden = true;
  cmdk.textContent = "";
  cmdkItems = [];
  cmdkIndex = 0;
  inp.setAttribute("aria-expanded", "false");
  inp.removeAttribute("aria-activedescendant");
}

function highlightCmdk(): void {
  Array.from(cmdk.children).forEach((node, i) => node.classList.toggle("on", i === cmdkIndex));
  const on = cmdk.children[cmdkIndex];
  if (on) inp.setAttribute("aria-activedescendant", on.id);
}

export function updateCmdk(): void {
  const token = slashToken();
  if (token === null || !webCommands.length) {
    closeCmdk();
    return;
  }
  const q = token.slice(1).toLowerCase();
  const matches = webCommands.filter((c) => String(c.name).toLowerCase().startsWith(q)).slice(0, 8);
  if (!matches.length) {
    closeCmdk();
    return;
  }
  cmdkItems = matches;
  cmdkIndex = 0;
  cmdk.textContent = "";
  matches.forEach((c, i) => {
    const item = el("div", "cmdk-item" + (i === 0 ? " on" : ""));
    item.id = "cmdk-opt-" + i;
    item.setAttribute("role", "option");
    item.appendChild(el("span", "cmd", c.usage));
    if (c.desc) item.appendChild(el("span", "desc", c.desc));
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptCmdk(i);
    });
    cmdk.appendChild(item);
  });
  cmdk.hidden = false;
  cmdk.setAttribute("aria-label", t("web.cmdk.label"));
  inp.setAttribute("aria-expanded", "true");
  inp.setAttribute("aria-controls", cmdk.id);
  highlightCmdk();
}

export function acceptCmdk(i: number): void {
  const c = cmdkItems[i];
  if (!c) return;
  inp.value = "/" + c.name + " ";
  autogrowFn();
  closeCmdk();
  inp.focus();
}

// Keyboard navigation while the list is open. Returns true when the key was
// consumed (the composer then skips its send/interrupt handling).
export function cmdkKeydown(e: KeyboardEvent): boolean {
  if (cmdk.hidden) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cmdkIndex = Math.min(cmdkIndex + 1, cmdkItems.length - 1);
    highlightCmdk();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    cmdkIndex = Math.max(cmdkIndex - 1, 0);
    highlightCmdk();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeCmdk();
    return true;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    acceptCmdk(cmdkIndex);
    return true;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    const token = slashToken();
    const selected = cmdkItems[cmdkIndex];
    // Exact command typed → let the composer send; otherwise complete it.
    if (token && selected && token.slice(1).toLowerCase() !== String(selected.name).toLowerCase()) {
      e.preventDefault();
      acceptCmdk(cmdkIndex);
      return true;
    }
  }
  return false;
}
