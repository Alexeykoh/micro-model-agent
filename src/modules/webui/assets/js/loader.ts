// Loader faces — a small squircle "agent presence": eyes + extra effects,
// driven entirely by CSS state classes. One component for the boot splash,
// the in-feed busy line, the activity rail and the first-run wizard.
// The mascot is called **MMART** (MMA + art): clicking it pops a localized
// greeting bubble. See docs/specs/2026-10-08-loader-webui-design.md.

import { populateFx } from "./loader-fx.js";
import { FACE_CLASS } from "./loader-states.js";

export { loaderStateFor, lspOutputSignal, toolState } from "./loader-states.js";
export type { LoaderSignal } from "./loader-states.js";

export type FaceState =
  | "idle" | "think" | "read" | "find" | "web" | "edit" | "type" | "create"
  | "run" | "tests" | "compact" | "plan" | "ask" | "done" | "error" | "stop"
  | "queued" | "boot" | "load" | "update"
  // LSP: идёт статическая проверка / сервер вернул ошибки.
  | "check" | "warn"
  // Гейт забраковал черновик: идёт штатная перепроверка/переответ.
  | "recheck";

export type FaceSize = "sm" | "lg" | "xs";

// ---- MMART: the mascot's identity and its greeting bubble ----
export const MMART_NAME = "MMART";
// app.ts injects the localized resolver so this module stays import-time-safe
// under `bun test` (i18n → api touches `location`, which is undefined there).
let greetResolver: () => string = () => `Привет! Я ${MMART_NAME}`;
export function setGreetResolver(fn: () => string): void {
  greetResolver = fn;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// A face always carries every extra element; CSS shows only the ones its
// state uses, so `setFaceState` never touches the DOM structure.
export function createFace(state: FaceState = "think", size: FaceSize | null = null): HTMLElement {
  const face = el("span");
  face.setAttribute("aria-hidden", "true");
  face.dataset.size = size || "";
  const eyes = el("span", "eyes");
  eyes.appendChild(el("i", "eye left"));
  eyes.appendChild(el("i", "eye right"));
  const orb = el("span", "orb");
  orb.appendChild(el("i"));
  const keys = el("span", "keys");
  for (let i = 0; i < 4; i++) keys.appendChild(el("i"));
  const dust = el("span", "dust");
  for (let i = 0; i < 3; i++) dust.appendChild(el("i"));
  const fx = el("span", "fx");
  for (let i = 0; i < 6; i++) fx.appendChild(el("i"));
  face.append(
    eyes, orb, keys, el("span", "grow"), el("span", "fly"), fx,
    el("span", "sweep"), dust, el("span", "q", "?"), el("span", "spark", "✦"), el("span", "star"),
    el("span", "mdl-tip"),
  );
  setFaceState(face, state);
  return face;
}

export function setFaceState(face: HTMLElement | null, state: FaceState): void {
  if (!face) return;
  const size = face.dataset.size || "";
  face.className = "mdl" + (size ? " " + size : "") + " " + FACE_CLASS[state];
  face.dataset.state = state;
  populateFx(face, state);
  // Drop any leftover cursor-tracking offsets/tilt so the new state starts clean.
  if (!FACE_CLASS[state].includes("track")) {
    face.style.setProperty("--ex", "0px");
    face.style.setProperty("--ey", "0px");
    face.style.setProperty("--tilt", "0deg");
  }
}

// ---- cursor tracking, click-to-blink and the MMART greeting for idle faces
// (`.track` / `.poke`) ----
const tipTimers = new WeakMap<HTMLElement, number>();

// Pop the localized greeting above the face. Repeated clicks restart the
// timer instead of stacking, so the bubble can never stick open.
function showGreeting(m: HTMLElement): void {
  const tip = m.querySelector<HTMLElement>(".mdl-tip");
  if (!tip) return;
  tip.textContent = greetResolver();
  m.classList.add("show-tip");
  const prev = tipTimers.get(m);
  if (prev !== undefined) window.clearTimeout(prev);
  tipTimers.set(
    m,
    window.setTimeout(() => {
      m.classList.remove("show-tip");
      tipTimers.delete(m);
    }, 2200),
  );
}

function trackTargets(sel: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(sel));
}

function lookAt(x: number, y: number): void {
  for (const m of trackTargets(".mdl.track")) {
    const r = m.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const maxShift = r.width * 0.16;
    const reach = Math.min(1, dist / 140);
    const nx = dx / dist;
    const ny = dy / dist;
    m.style.setProperty("--ex", (nx * maxShift * reach).toFixed(1) + "px");
    m.style.setProperty("--ey", (ny * maxShift * reach).toFixed(1) + "px");
    m.style.setProperty("--tilt", (nx * 6 * reach).toFixed(2) + "deg");
  }
}

function resetLook(): void {
  for (const m of trackTargets(".mdl.track")) {
    m.style.setProperty("--ex", "0px");
    m.style.setProperty("--ey", "0px");
    m.style.setProperty("--tilt", "0deg");
  }
}

// The click landed on the face itself (its own parts count). Anything else in
// the document only lets it blink — the greeting is not a page-wide easter egg.
function clickOnFace(e: MouseEvent): HTMLElement | null {
  const node = e.target as HTMLElement | null;
  if (!node || typeof node.closest !== "function") return null;
  return node.closest<HTMLElement>(".mdl.poke");
}

let cursorWired = false;

export function initCursor(): void {
  if (cursorWired || typeof window === "undefined") return;
  cursorWired = true;
  window.addEventListener("mousemove", (e) => lookAt(e.clientX, e.clientY));
  window.addEventListener("mouseleave", resetLook);
  // Click anywhere → idle faces blink. Every click restarts the blink, so fast
  // clicking keeps up (no lock-out guard).
  let pokeTimer: number | null = null;
  window.addEventListener("click", (e) => {
    const targets = trackTargets(".mdl.poke");
    if (targets.length) {
      for (const m of targets) {
        m.classList.remove("blink-once");
        void m.offsetWidth; // restart the CSS animation
        m.classList.add("blink-once");
      }
      if (pokeTimer !== null) window.clearTimeout(pokeTimer);
      pokeTimer = window.setTimeout(() => {
        for (const m of targets) m.classList.remove("blink-once");
        pokeTimer = null;
      }, 130);
    }
    const hit = clickOnFace(e);
    if (hit) showGreeting(hit);
  });
}
