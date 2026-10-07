// The single nested "edit one thing" dialog (provider, MCP server, LSP server,
// memory entry, plugin details, LSP setup info). Top-level leaf so both
// `settings/*` and `sidebar/*` can open it without a layer inversion.
//
// Nodes are resolved lazily on each call, not captured at import time: the
// module is imported before the overlay necessarily exists (and DOM tests share
// one process across windows), so an import-time capture silently no-ops.
import { trapTab } from "./dialog.js";

/** Nodes of вложенного оверлея; null, если разметки нет. */
interface SubNodes {
  overlay: HTMLElement | null;
  host: HTMLElement | null;
  title: HTMLElement | null;
  close: HTMLElement | null;
}

function subNodes(): SubNodes {
  return {
    overlay: document.getElementById("subOverlay"),
    host: document.getElementById("subHost"),
    title: document.getElementById("subTitle") as HTMLElement | null,
    close: document.getElementById("closeSub"),
  };
}

/** Оверлеи, к которым уже подвешены слушатели (идемпотентно). */
const wired = new WeakSet<HTMLElement>();

function wire(overlay: HTMLElement): void {
  if (wired.has(overlay)) return;
  wired.add(overlay);
  const closeBtn = overlay.querySelector<HTMLElement>("#closeSub");
  closeBtn?.addEventListener("click", closeSubDialog);
  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === overlay) closeSubDialog();
  });
  overlay.addEventListener("keydown", (e) => trapTab(overlay, e));
}

let subReturnFocus: HTMLElement | null = null;
let subOnClose: (() => void) | null = null;

export function isSubDialogOpen(): boolean {
  const overlay = subNodes().overlay;
  return !!overlay && overlay.classList.contains("open");
}

/** Open the nested dialog with a built content node. `onClose` runs after. */
export function openSubDialog(title: string, node: Node, onClose?: (() => void) | null): void {
  const { overlay, host, title: titleEl } = subNodes();
  if (!overlay || !host) return;
  wire(overlay);
  subReturnFocus = document.activeElement as HTMLElement | null;
  subOnClose = onClose || null;
  if (titleEl) titleEl.textContent = title;
  host.textContent = "";
  host.appendChild(node);
  overlay.classList.add("open");
  setTimeout(() => {
    const first = host.querySelector<HTMLElement>("input, select, textarea");
    if (first) first.focus();
  }, 0);
}

export function closeSubDialog(): void {
  const { overlay } = subNodes();
  if (!overlay || !overlay.classList.contains("open")) return;
  overlay.classList.remove("open");
  const after = subOnClose;
  subOnClose = null;
  if (subReturnFocus && subReturnFocus.focus) subReturnFocus.focus();
  subReturnFocus = null;
  if (after) after();
}
