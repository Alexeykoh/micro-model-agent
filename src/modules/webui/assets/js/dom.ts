// DOM refs + tiny element builders for the `mma web` frontend.
// Depends only on the icon table; every other module builds on these.
import { ICONS } from "./icons.js";

export const msgs = document.getElementById("msgs") as HTMLElement;
export const inp = document.getElementById("inp") as HTMLTextAreaElement;
export const tabstripEl = document.getElementById("tabstrip") as HTMLElement;
export const planEl = document.getElementById("plan") as HTMLElement;
export const planCountEl = document.getElementById("planCount") as HTMLElement;
export const usageEl = document.getElementById("usage") as HTMLElement;
export const envEl = document.getElementById("env") as HTMLElement;
export const wsLine = document.getElementById("wsLine") as HTMLElement;
export const saveIndicator = document.getElementById("saveIndicator") as HTMLElement;
export const attachStrip = document.getElementById("attachStrip") as HTMLElement;
export const attachErr = document.getElementById("attachErr") as HTMLElement;
export const imgPicker = document.getElementById("imgPicker") as HTMLInputElement;
export const connStatus = document.getElementById("connStatus") as HTMLElement;
export const staleBar = document.getElementById("staleBar") as HTMLElement;
export const liveEl = document.getElementById("live") as HTMLElement;
export const sendBtn = document.getElementById("sendBtn") as HTMLElement;

// Announce a short status line to assistive tech (turn end, warnings/errors).
// Clearing first forces repeats to be re-announced.
export function announce(text: string): void {
  if (!liveEl || !text) return;
  liveEl.textContent = "";
  setTimeout(() => {
    liveEl.textContent = text;
  }, 30);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string | number | null,
): HTMLElementTagNameMap[K];
export function el(tag: string, cls?: string | null, text?: string | number | null): HTMLElement;
export function el(tag: string, cls?: string | null, text?: string | number | null): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = String(text);
  return node;
}

// --- Hover/focus tooltips: one shared body-level node, positioned above the
// anchor (below when there is no room). Callers pass a builder so the content
// stays live (i18n changes, new values on re-render).
let tipEl: HTMLElement | null = null;
let tipBound = false;
function tipNode(): HTMLElement {
  if (!tipEl) {
    tipEl = el("div", "ctip");
    tipEl.setAttribute("role", "tooltip");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function hideTip(): void {
  if (tipEl) tipEl.classList.remove("show");
}
function bindTipDismiss(): void {
  if (tipBound) return;
  tipBound = true;
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);
}
export function attachTooltip(anchor: HTMLElement, build: () => Node): void {
  const show = (): void => {
    const tip = tipNode();
    tip.replaceChildren(build());
    tip.classList.add("show");
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - t.width - 6));
    let top = a.top - t.height - 7;
    if (top < 6) top = a.bottom + 7;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  };
  anchor.addEventListener("mouseenter", show);
  anchor.addEventListener("mouseleave", hideTip);
  anchor.addEventListener("focus", show);
  anchor.addEventListener("blur", hideTip);
  bindTipDismiss();
}

// --- Lucide icons (MIT), inlined: chrome only. Chat status glyphs (◇ ✓ ✗ ✦ ⟡ …)
// stay textual per docs/design/ui/STYLE.md; icons replace emoji/gear chrome.
export const SVG_NS = "http://www.w3.org/2000/svg";
export function icon(name: string, cls?: string | null): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "svg-icon" + (cls ? " " + cls : ""));
  (ICONS[name] || []).forEach(([tag, attrs]) => {
    const child = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((k) => child.setAttribute(k, String(attrs[k])));
    svg.appendChild(child);
  });
  return svg;
}

// Replace a node's contents with an icon + optional label, keeping it a real
// control. Returns the label node so callers can preserve text-only updates.
export function setIcon(
  button: HTMLElement | null,
  name: string,
  label?: string | null,
): HTMLElement | null {
  if (!button) return null;
  button.textContent = "";
  button.appendChild(icon(name));
  if (label != null) button.appendChild(el("span", "", label));
  return button;
}

// Accessible on/off switch (`role=switch`). `onFlip(next)` runs on click; the
// switch flips itself only when `onFlip` returns truthy — async callers that
// re-render instead (MCP list) return nothing and keep server truth.
export function makeToggle(
  on: boolean,
  onFlip: (next: boolean) => unknown,
): HTMLButtonElement {
  const b = el("button", "toggle" + (on ? " on" : ""));
  b.type = "button";
  b.setAttribute("role", "switch");
  b.setAttribute("aria-checked", on ? "true" : "false");
  b.addEventListener("click", () => {
    const next = !b.classList.contains("on");
    if (onFlip(next)) {
      b.classList.toggle("on", next);
      b.setAttribute("aria-checked", next ? "true" : "false");
    }
  });
  return b;
}

// Text action control (`edit`, `forget`, `add`, …) as a focusable <button>.
export function link(
  label: string,
  cls: string | null,
  onClick: (ev: MouseEvent) => void,
): HTMLButtonElement {
  const b = el("button", "linkbtn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

// Render raw memory text (`- **date** -- **pattern:** body`) as safe DOM nodes:
// `**…**` spans become <b>, everything else stays a text node. Never uses
// innerHTML, so untrusted/model-written content cannot inject markup.
export function inlineTextNodes(text: string | null | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  const raw = String(text == null ? "" : text).replace(/^-\s*/, "");
  raw.split("**").forEach((part, i) => {
    if (part === "") return;
    if (i % 2 === 1) {
      const b = document.createElement("b");
      b.textContent = part;
      frag.appendChild(b);
    } else {
      frag.appendChild(document.createTextNode(part));
    }
  });
  return frag;
}
