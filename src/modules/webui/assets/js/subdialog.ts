// The single nested "edit one thing" dialog (provider, MCP server, LSP server,
// memory entry, LSP setup info). Top-level leaf so both `settings/*` and
// `sidebar/*` can open it without a layer inversion. Only shared primitives.
import { trapTab } from "./dialog.js";

const subOverlay = document.getElementById("subOverlay");
const subHost = document.getElementById("subHost");
const subTitle = document.getElementById("subTitle") as HTMLElement;
const closeSubBtn = document.getElementById("closeSub");
let subReturnFocus: HTMLElement | null = null;
let subOnClose: (() => void) | null = null;

export function isSubDialogOpen(): boolean {
  return !!subOverlay && subOverlay.classList.contains("open");
}

/** Open the nested dialog with a built content node. `onClose` runs after. */
export function openSubDialog(title: string, node: Node, onClose?: (() => void) | null): void {
  if (!subOverlay || !subHost) return;
  subReturnFocus = document.activeElement as HTMLElement | null;
  subOnClose = onClose || null;
  subTitle.textContent = title;
  subHost.textContent = "";
  subHost.appendChild(node);
  subOverlay.classList.add("open");
  setTimeout(() => {
    const first = subHost.querySelector<HTMLElement>("input, select, textarea");
    if (first) first.focus();
  }, 0);
}

export function closeSubDialog(): void {
  if (!isSubDialogOpen() || !subOverlay) return;
  subOverlay.classList.remove("open");
  const after = subOnClose;
  subOnClose = null;
  if (subReturnFocus && subReturnFocus.focus) subReturnFocus.focus();
  subReturnFocus = null;
  if (after) after();
}

if (subOverlay) {
  if (closeSubBtn) closeSubBtn.addEventListener("click", closeSubDialog);
  subOverlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === subOverlay) closeSubDialog();
  });
  subOverlay.addEventListener("keydown", (e) => trapTab(subOverlay, e));
}
