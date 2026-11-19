// LSP off/offline presentation (U13): status flags, the persistent dot on the
// tab and the banner at the top of the pane. Split out of `lsp.ts` to keep the
// tab module under the 300-line rule; this module owns only the off-state UI.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";

export interface LspStatusFlags {
  disabled: boolean;
  offline: boolean;
}

/**
 * `unavailable` means the module itself is off (e.g. `mma serve` without LSP).
 * A disabled switch wins over offline: checks do not run at all.
 */
export function lspStatusFlags(diag: Dict | null, unavailable = false): LspStatusFlags {
  if (unavailable) return { disabled: true, offline: false };
  if (!diag) return { disabled: false, offline: false };
  return { disabled: diag.enabled === false, offline: diag.offline === true };
}

/** Paints the off/offline dot on the LSP tab and updates its accessible name. */
export function applyLspIndicator(
  root: HTMLElement | null,
  diag: Dict | null,
  unavailable = false,
): void {
  const tab = root?.querySelector<HTMLElement>('.sb-tab[data-tab="lsp"]');
  if (!tab) return;
  const flags = lspStatusFlags(diag, unavailable);
  tab.dataset.indicator = flags.disabled ? "off" : flags.offline ? "offline" : "";
  const base = t("web.sidebar.tab_lsp");
  const suffix = flags.disabled
    ? t("web.sidebar.lsp_off")
    : flags.offline
      ? t("web.sidebar.lsp_offline")
      : "";
  const label = suffix ? `${base} · ${suffix}` : base;
  tab.title = label;
  tab.setAttribute("aria-label", label);
}

/** Visible banner at the top of the pane when checks cannot run normally. */
export function appendStatusBanner(
  host: HTMLElement,
  diag: Dict | null,
  unavailable: boolean,
  onConfigure: () => void,
): void {
  const flags = lspStatusFlags(diag, unavailable);
  if (!flags.disabled && !flags.offline) return;
  const banner = el("div", "lsp-banner " + (flags.disabled ? "off" : "offline"));
  const glyph = el("span", "lsp-banner-g", flags.disabled ? "–" : "⏻");
  glyph.setAttribute("aria-hidden", "true");
  banner.appendChild(glyph);
  banner.appendChild(
    el(
      "span",
      "lsp-banner-text",
      t(flags.disabled ? "web.sidebar.lsp_banner_disabled" : "web.sidebar.lsp_banner_offline"),
    ),
  );
  const setup = el("button", "linkbtn lsp-banner-btn", t("web.sidebar.lsp_configure"));
  setup.type = "button";
  setup.addEventListener("click", onConfigure);
  banner.appendChild(setup);
  host.appendChild(banner);
}
