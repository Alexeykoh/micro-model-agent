// Install chrome for the web update flow: localized progress labels, install
// button sync across surfaces (feed card + settings row) and the SSE `update`
// dispatch. Extracted from `app.ts` (file-size rule 6).
import { t } from "./i18n.js";
import { fmtBytes } from "./format.js";
import { setIndicator } from "./dialog.js";
import type { Dict } from "./core/store/types.js";
import type { FaceState } from "./loader.js";

/** Localized progress label shown on the install button. */
export function updateProgressText(p: Dict | undefined): string {
  if (!p || typeof p.phase !== "string") return t("web.update.installing");
  if (p.phase === "download") {
    const total = typeof p.total === "number" ? fmtBytes(p.total) : "";
    const done = typeof p.received === "number" ? fmtBytes(p.received) : "";
    if (total && typeof p.received === "number" && p.total) {
      return t("web.update.downloading_pct", {
        pct: Math.round((p.received / p.total) * 100),
        done,
        total,
      });
    }
    return done ? t("web.update.downloading", { done }) : t("web.update.installing");
  }
  return t("web.update.stage_" + p.phase);
}

/**
 * Every install button (feed card + settings row) shows the same label/state, so
 * starting an install on one surface disables the other.
 */
export function setUpdateButtons(text: string, disabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement>(".upd-btn").forEach((b) => {
    b.textContent = text;
    b.disabled = disabled;
  });
}

/** App-shell hooks the update chrome needs (kept out of this leaf). */
export interface UpdateUiHooks {
  /** MMART reaction for the phase. */
  face(state: FaceState): void;
  /** Schedule the settle-back-to-idle after an `available` notice. */
  settleIdle(): void;
  /** Re-render settings + a top-level empty feed after a successful install. */
  refreshChrome(): void;
}

/** Dispatch one SSE `update` payload to the shared install chrome. */
export function applyUpdateEvent(d: Dict, hooks: UpdateUiHooks): void {
  if (d.phase === "installing") {
    hooks.face("update");
    setUpdateButtons(updateProgressText(d.progress), true);
    return;
  }
  if (d.phase === "failed") {
    hooks.face("error");
    setUpdateButtons(t("web.update.install"), false);
    setIndicator(t("web.update.failed"), true);
    return;
  }
  if (d.phase === "installed") {
    hooks.face("done");
    setUpdateButtons(t("web.update.install"), false);
    setIndicator(t("web.update.installed", { latest: String(d.latest || "") }), false);
    hooks.refreshChrome();
    return;
  }
  // available
  hooks.face("update");
  hooks.settleIdle();
}
