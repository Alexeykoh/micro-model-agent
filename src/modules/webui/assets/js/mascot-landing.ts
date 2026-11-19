// Landing-page entry: exposes the canvas mascot as `window.MMART` so the
// hand-written `gh-pages/app.js` can attach faces without a module graph.
import type { FaceState } from "./loader-states.js";
import { attachMascot, mascotLookAt, mascotPokeAll, type MascotHandle } from "./mascot-canvas.js";

const handles = new WeakMap<HTMLElement, MascotHandle>();

function attach(el: HTMLElement, state: FaceState): MascotHandle {
  const existing = handles.get(el);
  if (existing) return existing;
  let canvas = el.querySelector<HTMLCanvasElement>("canvas.mdl-cv");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "mdl-cv";
    el.appendChild(canvas);
  }
  el.classList.add("has-canvas");
  const handle = attachMascot(canvas, state);
  handles.set(el, handle);
  handle.setState(state);
  return handle;
}

function setState(el: HTMLElement, state: FaceState): void {
  attach(el, state).setState(state);
}

function poke(el: HTMLElement): void {
  handles.get(el)?.poke();
}

declare global {
  interface Window {
    MMART?: {
      attach: typeof attach;
      setState: typeof setState;
      poke: typeof poke;
      lookAt: typeof mascotLookAt;
      pokeAll: typeof mascotPokeAll;
    };
  }
}

window.MMART = { attach, setState, poke, lookAt: mascotLookAt, pokeAll: mascotPokeAll };
