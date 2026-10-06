// DOM refs + tiny element builders for the `mma web` frontend.
// No dependencies: every other module builds on these.

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
export type IconSpec = Array<[string, Record<string, string | number>]>;
export const ICONS: Record<string, IconSpec> = {
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  menu: [
    ["line", { x1: 4, y1: 6, x2: 20, y2: 6 }],
    ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }],
  ],
  settings: [
    [
      "path",
      {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    ],
    ["circle", { cx: 12, cy: 12, r: 3 }],
  ],
  image: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
    ["circle", { cx: 9, cy: 9, r: 2 }],
    ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }],
  ],
  x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  trash: [
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
    ["line", { x1: 10, y1: 11, x2: 10, y2: 17 }],
    ["line", { x1: 14, y1: 11, x2: 14, y2: 17 }],
  ],
  refresh: [
    ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
    ["path", { d: "M8 21H3v-5" }],
  ],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  search: [
    ["circle", { cx: 11, cy: 11, r: 8 }],
    ["path", { d: "m21 21-4.3-4.3" }],
  ],
  "list-checks": [
    ["path", { d: "m3 17 2 2 4-4" }],
    ["path", { d: "m3 7 2 2 4-4" }],
    ["path", { d: "M13 6h8" }],
    ["path", { d: "M13 12h8" }],
    ["path", { d: "M13 18h8" }],
  ],
  map: [
    [
      "path",
      {
        d: "M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z",
      },
    ],
    ["path", { d: "M15 5.764v15" }],
    ["path", { d: "M9 3.236v15" }],
  ],
  activity: [
    [
      "path",
      {
        d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
      },
    ],
  ],
  "arrow-up": [["path", { d: "M12 19V5" }], ["path", { d: "m5 12 7-7 7 7" }]],
  panel: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
    ["line", { x1: 15, y1: 3, x2: 15, y2: 21 }],
  ],
  square: [["rect", { width: 14, height: 14, x: 5, y: 5, rx: 2 }]],
  copy: [
    ["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  info: [
    ["circle", { cx: 12, cy: 12, r: 10 }],
    ["path", { d: "M12 16v-4" }],
    ["path", { d: "M12 8h.01" }],
  ],
  stethoscope: [
    ["path", { d: "M11 2v2" }],
    ["path", { d: "M5 2v2" }],
    ["path", { d: "M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" }],
    ["path", { d: "M8 15a6 6 0 0 0 12 0v-3" }],
    ["circle", { cx: 20, cy: 10, r: 2 }],
  ],
  "folder-tree": [
    ["path", { d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" }],
    ["path", { d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.9-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" }],
    ["path", { d: "M3 5a2 2 0 0 1 2-2h3" }],
    ["path", { d: "M3 3v13a3 3 0 0 0 3 3h4" }],
  ],
  folder: [
    ["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }],
  ],
  file: [
    ["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }],
    ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
  ],
  paperclip: [
    ["path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" }],
  ],
};

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
