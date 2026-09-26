// DOM refs + tiny element builders for the `mma web` frontend.
// No dependencies: every other module builds on these.

export const msgs = document.getElementById("msgs");
export const inp = document.getElementById("inp");
export const tabstripEl = document.getElementById("tabstrip");
export const planEl = document.getElementById("plan");
export const planCountEl = document.getElementById("planCount");
export const usageEl = document.getElementById("usage");
export const envEl = document.getElementById("env");
export const wsLine = document.getElementById("wsLine");
export const saveIndicator = document.getElementById("saveIndicator");
export const attachStrip = document.getElementById("attachStrip");
export const attachErr = document.getElementById("attachErr");
export const imgPicker = document.getElementById("imgPicker");
export const connStatus = document.getElementById("connStatus");
export const liveEl = document.getElementById("live");
export const sendBtn = document.getElementById("sendBtn");

// Announce a short status line to assistive tech (turn end, warnings/errors).
// Clearing first forces repeats to be re-announced.
export function announce(text) {
if (!liveEl || !text) return;
liveEl.textContent = "";
setTimeout(() => {
  liveEl.textContent = text;
}, 30);
}

export function el(tag, cls, text) {
const node = document.createElement(tag);
if (cls) node.className = cls;
if (text != null) node.textContent = text;
return node;
}

// --- Lucide icons (MIT), inlined: chrome only. Chat status glyphs (◇ ✓ ✗ ✦ ⟡ …)
// stay textual per docs/design/ui/STYLE.md; icons replace emoji/gear chrome.
export const SVG_NS = "http://www.w3.org/2000/svg";
export const ICONS = {
plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
menu: [
  ["line", { x1: 4, y1: 6, x2: 20, y2: 6 }],
  ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
  ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }],
],
settings: [
  ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
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
"chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
"arrow-up": [["path", { d: "M12 19V5" }], ["path", { d: "m5 12 7-7 7 7" }]],
square: [["rect", { width: 14, height: 14, x: 5, y: 5, rx: 2 }]],
copy: [
  ["rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
],
check: [["path", { d: "M20 6 9 17l-5-5" }]],
};

export function icon(name, cls) {
const svg = document.createElementNS(SVG_NS, "svg");
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
export function setIcon(button, name, label) {
if (!button) return null;
button.textContent = "";
button.appendChild(icon(name));
if (label != null) button.appendChild(el("span", "", label));
return button;
}

// Accessible on/off switch (`role=switch`). `onFlip(next)` runs on click; the
// switch flips itself only when `onFlip` returns truthy — async callers that
// re-render instead (MCP list) return nothing and keep server truth.
export function makeToggle(on, onFlip) {
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
export function link(label, cls, onClick) {
const b = el("button", "linkbtn" + (cls ? " " + cls : ""), label);
b.type = "button";
b.addEventListener("click", onClick);
return b;
}

// Upgrade an existing non-button node (a span/div kept for layout) into a
// keyboard-activatable control.
export function activate(node, fn) {
node.setAttribute("role", "button");
if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
node.addEventListener("click", fn);
node.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn(e);
  }
});
return node;
}

// Render raw memory text (`- **date** -- **pattern:** body`) as safe DOM nodes:
// `**…**` spans become <b>, everything else stays a text node. Never uses
// innerHTML, so untrusted/model-written content cannot inject markup.
export function inlineTextNodes(text) {
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
