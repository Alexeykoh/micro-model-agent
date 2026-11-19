// Global keyboard shortcuts for `mma web` (U16). Two destinations only, both
// modeless and both already reachable with the mouse: sessions (`Ctrl/Cmd+K`,
// the familiar "command palette" muscle memory) and file search (`Ctrl/Cmd+P`).
// Alt+1..9 stays the tab switcher and `/` stays the composer command palette;
// this module must not fight either of them.
import { openSessionsMenu } from "./session/sessions-menu.js";
import { setSidebarTab } from "./sidebar/core.js";
import { mqNarrow } from "./sidebar/state.js";
import { sidebarDrawerOpen, setSidebarDrawer } from "./sidebar/drawer.js";

export type ShortcutAction = "sessions" | "files";

/**
 * Pure key classification. Shift/Alt combinations are left to the browser and
 * to the existing handlers (Alt+N tabs, Shift+Enter composer).
 */
export function shortcutFor(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): ShortcutAction | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const key = String(e.key).toLowerCase();
  if (key === "k") return "sessions";
  if (key === "p") return "files";
  return null;
}

let wired = false;

/** Focus after the dropdown/drawer has rendered (the nodes exist statically). */
function focusSoon(id: string): void {
  window.setTimeout(() => {
    document.getElementById(id)?.focus();
  }, 0);
}

export function initShortcuts(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("keydown", (e) => {
    const action = shortcutFor(e);
    if (!action) return;
    e.preventDefault();
    if (action === "sessions") {
      openSessionsMenu();
      focusSoon("sessSearch");
      return;
    }
    setSidebarTab("files");
    // On a phone/narrow window the sidebar is a drawer: a shortcut that focuses
    // an off-screen field is a dead end.
    if (mqNarrow() && !sidebarDrawerOpen()) setSidebarDrawer(true);
    focusSoon("filesSearch");
  });
}
