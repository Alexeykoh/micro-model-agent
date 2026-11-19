// Topbar menu coordination (leaf): closes `[data-sel]` dropdowns and the
// sessions dropdown. Lives *below* `tabs`/`settings` so `settings.js` no longer
// imports `tabs.js` — removes the only frontend layer inversion (the DAG stays
// app → settings → tabs → feed). The sessions-dropdown filter cleanup is a hook
// registered by `tabs.js`, so this leaf never depends upward.

const sessDD = document.getElementById("sessDD");
const sessBtn = document.getElementById("sessBtn");

let onSessionClosed: (() => void) | null = null;

/** `tabs.js` registers the query-reset + re-render to run when the dropdown closes. */
export function setSessionCloseHook(fn: () => void): void {
  onSessionClosed = fn;
}

export function setSessOpen(open: boolean): void {
  if (sessDD) sessDD.classList.toggle("open", !!open);
  if (sessBtn) sessBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open && onSessionClosed) onSessionClosed();
}

export function closeAllMenus(): void {
  document.querySelectorAll("[data-sel]").forEach((s) => {
    s.classList.remove("open");
    const b = s.querySelector("button");
    if (b) b.setAttribute("aria-expanded", "false");
  });
  setSessOpen(false);
}
