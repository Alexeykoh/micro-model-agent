// Loader faces — a small squircle "agent presence". One component for the boot
// splash, the in-feed busy line, the activity rail and the first-run wizard.
// The mascot is called **MMART** (MMA + art): clicking it pops a localized
// greeting bubble. Rendering is Canvas 2D (`mascot-canvas.ts`); the wrapper
// keeps the state classes, size and greeting bubble.
// See docs/specs/2026-10-08-loader-webui-design.md.

import { attachMascot, mascotLookAt, mascotPokeAll, type MascotHandle } from "./mascot-canvas.js";
import { FACE_CLASS, type FaceSize, type FaceState } from "./loader-states.js";

export { loaderStateFor, lspOutputSignal, toolState } from "./loader-states.js";
export type { FaceSize, FaceState, LoaderSignal } from "./loader-states.js";

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

const handles = new WeakMap<HTMLElement, MascotHandle>();

export function createFace(state: FaceState = "think", size: FaceSize | null = null): HTMLElement {
  const face = el("span");
  face.setAttribute("aria-hidden", "true");
  face.dataset.size = size || "";
  const canvas = document.createElement("canvas");
  canvas.className = "mdl-cv";
  face.appendChild(canvas);
  face.appendChild(el("span", "mdl-tip"));
  handles.set(face, attachMascot(canvas, state));
  setFaceState(face, state);
  return face;
}

export function setFaceState(face: HTMLElement | null, state: FaceState): void {
  if (!face) return;
  const size = face.dataset.size || "";
  face.className = "mdl has-canvas" + (size ? " " + size : "") + " " + FACE_CLASS[state];
  face.dataset.state = state;
  handles.get(face)?.setState(state);
}

// ---- cursor tracking, click-to-blink and the MMART greeting for idle faces
// (`.track` / `.poke`) ----
const tipTimers = new WeakMap<HTMLElement, number>();

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
  window.addEventListener("mousemove", (e) => mascotLookAt(e.clientX, e.clientY));
  window.addEventListener("mouseleave", () => mascotLookAt(-10000, -10000));
  // Click anywhere → idle faces blink. Every click restarts the blink, so fast
  // clicking keeps up (no lock-out guard).
  window.addEventListener("click", (e) => {
    mascotPokeAll();
    const hit = clickOnFace(e);
    if (hit) showGreeting(hit);
  });
}

// Static `.mdl` markup in index.html (boot splash, sidebar loader) is upgraded
// to canvas as soon as this module loads, so no CSS-only face survives.
function stateFromClasses(el: HTMLElement): FaceState {
  for (const cls of el.classList) {
    if (!cls.startsWith("st-")) continue;
    for (const key of Object.keys(FACE_CLASS) as FaceState[]) {
      if (FACE_CLASS[key].split(" ").includes(cls)) return key;
    }
  }
  return "idle";
}

function upgradeStaticFaces(): void {
  if (typeof document === "undefined") return;
  for (const host of Array.from(document.querySelectorAll<HTMLElement>(".mdl:not(.has-canvas)"))) {
    const size = host.classList.contains("lg") ? "lg" : host.classList.contains("sm") ? "sm" : host.classList.contains("xs") ? "xs" : null;
    const face = createFace(stateFromClasses(host), size);
    for (const cls of host.classList) {
      if (cls === "mdl" || cls === "lg" || cls === "sm" || cls === "xs" || cls.startsWith("c-") || cls.startsWith("st-") || cls === "track" || cls === "poke" || cls === "blink") continue;
      face.classList.add(cls);
    }
    host.replaceWith(face);
  }
}

upgradeStaticFaces();
