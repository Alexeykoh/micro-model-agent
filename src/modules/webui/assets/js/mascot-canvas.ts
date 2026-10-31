// Canvas mascot runtime: one shared rAF loop for every face, a spring pose,
// theme-aware palette and reduced-motion handling. `loader.ts` keeps the public
// createFace/setFaceState API; this module only owns the pixels.
import { FACE_CLASS, type FaceState } from "./loader-states.js";
import { renderFace } from "./mascot-draw.js";
import { catOfElement, palette, radiusFraction } from "./mascot-palette.js";
import { STATE_CFG, type StateCfg } from "./mascot-pose.js";
import type { FaceColors, Pose } from "./mascot-types.js";
import { seedAt } from "./mascot-util.js";

export interface MascotHandle {
  setState(state: FaceState): void;
  poke(): void;
  destroy(): void;
}

const K = 190;
const C = 20;

const instances = new Set<Mascot>();
let themeVersion = 0;
let reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;

class Mascot {
  readonly canvas: HTMLCanvasElement;
  readonly handle: MascotHandle;
  readonly ctx: CanvasRenderingContext2D | null;
  track = false;
  private state: FaceState;
  private prevState: FaceState;
  private cfg: StateCfg;
  private prevCfg: StateCfg;
  private colors: FaceColors;
  private prevColors: FaceColors;
  private paletteVersion = -1;
  private pose: Pose;
  private vel: Record<string, number> = {};
  private time = 0;
  private entry = 0;
  private mix = 1;
  private pulse = 0;
  private seed: number;
  private prevSeed: number;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private radius = 0.32;
  visible = true;
  private trackX = 0;
  private trackY = 0;
  private targetX = 0;
  private targetY = 0;
  private blinkOnce = 0;
  private layer: HTMLCanvasElement | null = null;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;

  constructor(canvas: HTMLCanvasElement, state: FaceState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = state;
    this.prevState = state;
    this.cfg = STATE_CFG[state];
    this.prevCfg = this.cfg;
    this.pose = { ...this.cfg.pose };
    this.seed = seedAt(state.length + state.charCodeAt(0), 3);
    this.prevSeed = this.seed;
    this.colors = palette(canvas, catOfElement(canvas.parentElement, state));
    this.prevColors = this.colors;
    this.track = FACE_CLASS[state].includes("track");
    this.handle = {
      setState: (s) => this.setState(s),
      poke: () => { this.blinkOnce = 0.14; if (reduced) this.draw(); },
      destroy: () => this.destroy(),
    };
    this.bindSize();
  }

  private bindSize(): void {
    const apply = (): void => {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(8, Math.round(rect.width));
      const h = Math.max(8, Math.round(rect.height));
      const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.paletteVersion = -1;
      this.draw();
    };
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(apply);
      this.ro.observe(this.canvas);
    }
    apply();
    // The face is created detached and inserted right after; measure again once
    // layout has run (and once more after fonts/styles settle).
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
    if (typeof window !== "undefined") {
      window.setTimeout(apply, 80);
      window.setTimeout(apply, 400);
    }
    if (typeof IntersectionObserver === "function") {
      this.io = new IntersectionObserver((rows) => {
        for (const row of rows) this.visible = row.isIntersecting;
      }, { rootMargin: "100px" });
      this.io.observe(this.canvas);
    }
  }

  setState(state: FaceState): void {
    // Call sites re-apply the same state on every SSE tick; never restart a
    // transition (or reset the pose) for a no-op.
    if (state === this.state) return;
    this.trackX = 0;
    this.trackY = 0;
    const switching = state !== this.state && !reduced;
    if (switching) {
      this.prevState = this.state;
      this.prevCfg = this.cfg;
      this.prevSeed = this.seed;
      this.prevColors = this.colors;
    }
    this.state = state;
    this.cfg = STATE_CFG[state];
    this.seed = seedAt(state.length + state.charCodeAt(0), 3);
    this.entry = 0;
    this.track = FACE_CLASS[state].includes("track");
    this.paletteVersion = -1;
    if (!this.track) {
      this.targetX = 0;
      this.targetY = 0;
    }
    if (switching) {
      this.mix = 0;
      this.pulse = 1;
    } else {
      this.prevState = state;
      this.prevCfg = this.cfg;
      this.prevSeed = this.seed;
      this.prevColors = this.colors;
      this.mix = 1;
      this.pulse = 0;
      this.pose = { ...this.cfg.pose };
      for (const k in this.vel) this.vel[k] = 0;
    }
    this.draw();
  }

  lookAt(x: number, y: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / 140);
    this.targetX = (dx / dist) * reach;
    this.targetY = (dy / dist) * reach;
  }

  advance(dt: number): void {
    this.time += dt;
    this.entry += dt;
    if (this.mix < 1) this.mix = Math.min(1, this.mix + dt / 0.36);
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt / 0.42);
    if (this.blinkOnce > 0) this.blinkOnce = Math.max(0, this.blinkOnce - dt);
    this.trackX += (this.targetX - this.trackX) * Math.min(1, dt * 10);
    this.trackY += (this.targetY - this.trackY) * Math.min(1, dt * 10);
    const target = this.cfg.pose;
    for (const key in target) {
      const k = key as keyof Pose;
      if (this.pose[k] === undefined) this.pose[k] = target[k];
      if (this.vel[k] === undefined) this.vel[k] = 0;
      const a = (target[k] - this.pose[k]) * K - this.vel[k] * C;
      this.vel[k] += a * dt;
      this.pose[k] += this.vel[k] * dt;
    }
  }

  draw(): void {
    if (!this.ctx) return;
    if (themeVersion !== this.paletteVersion) {
      this.colors = palette(this.canvas, catOfElement(this.canvas.parentElement, this.state));
      this.prevColors = palette(this.canvas, catOfElement(this.canvas.parentElement, this.prevState));
      this.radius = radiusFraction(this.canvas);
      this.paletteVersion = themeVersion;
    }    if (this.mix < 1 && !this.layer) this.layer = document.createElement("canvas");
    if (this.layer && (this.layer.width !== this.canvas.width || this.layer.height !== this.canvas.height)) {
      this.layer.width = this.canvas.width;
      this.layer.height = this.canvas.height;
    }
    renderFace({
      ctx: this.ctx,
      layer: this.mix < 1 ? this.layer : null,
      w: this.w, h: this.h, dpr: this.dpr,
      cfg: this.cfg, prevCfg: this.prevCfg,
      colors: this.colors, prevColors: this.prevColors,
      state: this.state, prevState: this.prevState,
      pose: this.pose, time: reduced ? 0.9 : this.time, entry: this.entry,
      seed: this.seed, prevSeed: this.prevSeed,
      mix: reduced ? 1 : this.mix, pulse: this.pulse,
      trackX: this.trackX, trackY: this.trackY, blinkOnce: this.blinkOnce,
      radius: this.radius,
    });
  }

  destroy(): void {
    instances.delete(this);
    this.ro?.disconnect();
    this.io?.disconnect();
    this.layer = null;
  }
}

// ---------- shared loop ----------
let raf = 0;
let last = 0;
let frames = 0;
function loop(now: number): void {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;
  // Faces are created/destroyed by the feed; drop the ones removed from the DOM.
  if (++frames % 120 === 0) {
    for (const m of instances) if (!m.canvas.isConnected) m.destroy();
  }
  for (const m of instances) {
    if (!m.visible) continue;
    m.advance(dt);
    m.draw();
  }
  raf = requestAnimationFrame(loop);
}
function start(): void {
  if (raf || reduced || typeof requestAnimationFrame !== "function") return;
  last = 0;
  raf = requestAnimationFrame(loop);
}
function stop(): void {
  if (!raf || typeof cancelAnimationFrame !== "function") return;
  cancelAnimationFrame(raf);
  raf = 0;
}

export function attachMascot(canvas: HTMLCanvasElement, state: FaceState): MascotHandle {
  const m = new Mascot(canvas, state);
  if (m.ctx) {
    instances.add(m);
    start();
  }
  return m.handle;
}

export function mascotLookAt(x: number, y: number): void {
  for (const m of instances) if (m.track) m.lookAt(x, y);
}

export function mascotPokeAll(): void {
  for (const m of instances) if (m.track) m.handle.poke();
}

if (typeof window !== "undefined") {
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  mq?.addEventListener("change", (e) => {
    reduced = e.matches;
    if (reduced) stop();
    else start();
    for (const m of instances) m.draw();
  });
  if (typeof MutationObserver === "function" && document.body) {
    const bumpTheme = (): void => {
      themeVersion++;
      for (const m of instances) m.draw();
    };
    new MutationObserver(bumpTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // The landing page toggles `html.light`; the app toggles `body.light`.
    if (document.documentElement && document.documentElement !== document.body) {
      new MutationObserver(bumpTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
  }
}
