// Theme-aware palette for the canvas mascot. Colours come from the same CSS
// tokens as the DOM UI, so light/dark (and any accent theme) stay in sync.
import type { FaceState } from "./loader-states.js";
import { FACE_CLASS } from "./loader-states.js";
import type { FaceColors } from "./mascot-types.js";
import { ensureContrast, mixHex } from "./mascot-util.js";

const FALLBACK: Record<string, string> = {
  "--surface": "#1f1f1f", "--panel": "#191919", "--dim-a": "#a3a3a3",
  "--accent": "#c4a8ec", "--accent-bg": "#241e30", "--recon": "#38bdf8",
  "--mutate": "#e879c8", "--exec": "#6ea8fe", "--green": "#c9c5bd",
  "--yellow": "#d9a45b", "--red": "#e08080",
};

const EYE: Record<string, [string, string]> = {
  "c-active": ["#241e30", "#241e30"],
  "c-recon": ["#08222f", "#eaf6ff"],
  "c-mutate": ["#2e0b24", "#fff0fa"],
  "c-exec": ["#0a1730", "#eaf1ff"],
  "c-ok": ["#04221a", "#eafff6"],
  "c-warn": ["#2a1e05", "#fff8e6"],
  "c-err": ["#2a0d0d", "#ffecec"],
};

const BG: Record<string, string> = {
  "c-active": "--accent", "c-recon": "--recon", "c-mutate": "--mutate",
  "c-exec": "--exec", "c-ok": "--green", "c-warn": "--yellow", "c-err": "--red",
};

export function catOf(state: FaceState): string {
  return FACE_CLASS[state].split(" ")[0];
}

/** The element's own `c-*` class wins (the landing page sets colours apart
 *  from the state), otherwise fall back to the state's category. */
export function catOfElement(el: HTMLElement | null, state: FaceState): string {
  if (el) {
    for (const cls of el.classList) {
      if (cls.startsWith("c-")) return cls;
    }
  }
  return catOf(state);
}

export function palette(el: HTMLElement, cat: string): FaceColors {
  const win = el.ownerDocument.defaultView;
  const cs = win ? win.getComputedStyle(el) : null;
  const doc = el.ownerDocument;
  const isLight = !!doc.documentElement?.classList.contains("light") || !!doc.body?.classList.contains("light");
  const get = (name: string): string =>
    (cs ? cs.getPropertyValue(name).trim() : "") || FALLBACK[name] || "#888888";
  const panel = get("--panel");
  const face = cat === "c-dim" ? get("--surface") : get(BG[cat] || "--accent");
  const eyePref = cat === "c-dim" ? get("--dim-a") : isLight ? EYE[cat][1] : EYE[cat][0];
  const eye = ensureContrast(eyePref, face, 4.5);
  // `c-dim` is deliberately low-contrast against the panel (it carries a border
  // in CSS); forcing 3:1 would turn the "at rest" face grey.
  const faceAdj = cat === "c-dim" ? face : ensureContrast(face, panel, 3);
  return {
    face: faceAdj,
    eye,
    edge: cat === "c-dim" ? get("--border-2") : mixHex(faceAdj, isLight ? "#000000" : "#ffffff", 0.22),
    accent: cat === "c-dim" ? get("--dim-a") : get(BG[cat] || "--accent"),
    isLight,
  };
}

/**
 * Corner radius as a fraction of the *body*, read from the wrapper's computed
 * `border-radius`. Seasonal themes set `border-radius: 0 !important` on every
 * element; the canvas must follow, not hard-code the squircle.
 */
export function radiusFraction(el: HTMLElement): number {
  const win = el.ownerDocument.defaultView;
  const host = el.parentElement;
  if (!win || !host) return 0.32;
  const cs = win.getComputedStyle(host);
  const raw = cs.borderTopLeftRadius;
  const rect = host.getBoundingClientRect();
  const faceSize = Math.min(rect.width, rect.height);
  if (!faceSize) return 0.32;
  // Chrome returns `32%` for a percentage radius and `0px` for the seasonal
  // `border-radius: 0 !important` themes. Handle both; parseFloat("%") would
  // otherwise clamp every face to a circle.
  const n = parseFloat(raw) || 0;
  const px = raw.trim().endsWith("%") ? (n / 100) * faceSize : n;
  return Math.max(0, Math.min(0.5, px / faceSize));
}
