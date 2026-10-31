// Per-state look and body language for the canvas mascot. This is the single
// place where a face state becomes eyes + pose + prop + ambient effects.
import type { FaceState } from "./loader-states.js";
import type { FxCfg, Pose, PropCfg } from "./mascot-types.js";

export type EyeShape = "pill" | "narrow" | "squint" | "wide" | "happy" | "sad" | "sleep" | "wake";
export type Wave =
  | null
  | "breathe"
  | "hop"
  | "nod"
  | "sag"
  | "tilt"
  | "sway"
  | "float"
  | "type"
  | "ping"
  | "pulse"
  | "compact"
  | "read"
  | "edit";

export interface Drift {
  x: number;
  y: number;
  speed: number;
}

export interface StateCfg {
  eye: EyeShape;
  blink: number;
  wave: Wave;
  pose: Pose;
  lean: number;
  drift?: Drift;
  props: PropCfg[];
  fx: FxCfg[];
}

function P(o: Partial<Pose> = {}): Pose {
  return {
    sx: 1, sy: 1, y: 0, rot: 0, eX: 0, eY: 0,
    eW: 0.14, eH: 0.34, spread: 0.16, tilt: 0,
    ...o,
  };
}

export const STATE_CFG: Record<FaceState, StateCfg> = {
  idle: {
    eye: "pill", blink: 4.2, wave: "breathe", pose: P(), lean: 0,
    drift: { x: 0.018, y: 0.014, speed: 0.22 },
    props: [],
    fx: [
      { type: "orbit", when: "behind", n: 3, r0: 0.4, r1: 0.5, speed: 0.22, size: 0.014, alpha: 0.42 },
      { type: "orbit", when: "front", n: 2, r0: 0.4, r1: 0.46, speed: -0.16, size: 0.011, alpha: 0.5 },
    ],
  },
  queued: {
    eye: "pill", blink: 4.6, wave: "sway", pose: P({ rot: 0.02, eX: -0.012 }), lean: 0,
    drift: { x: 0.03, y: 0.012, speed: 0.3 },
    props: [{ type: "hourglass" }],
    fx: [
      { type: "orbit", when: "behind", n: 4, r0: 0.4, r1: 0.52, speed: 0.3, size: 0.013, alpha: 0.4 },
      { type: "corners", when: "front", r: 0.44, speed: 0.8, alpha: 0.45 },
    ],
  },
  boot: {
    eye: "pill", blink: 3.4, wave: "float", pose: P({ sx: 0.94, sy: 0.94 }), lean: 0,
    props: [{ type: "bar" }],
    fx: [
      { type: "corners", when: "behind", r: 0.44, speed: 1.5, alpha: 0.6 },
      { type: "orbit", when: "front", n: 3, r0: 0.38, r1: 0.46, speed: 0.7, size: 0.012, alpha: 0.5 },
    ],
  },
  load: {
    eye: "wake", blink: 0, wave: "float", pose: P(), lean: 0,
    props: [{ type: "bar" }],
    fx: [
      { type: "corners", when: "front", r: 0.46, speed: 0.5, alpha: 0.35 },
      { type: "orbit", when: "behind", n: 3, r0: 0.4, r1: 0.5, speed: 0.35, size: 0.012, alpha: 0.35 },
    ],
  },
  stop: {
    eye: "sleep", blink: 0, wave: null, pose: P({ sy: 0.93, y: 0.02 }), lean: 0,
    props: [{ type: "stopBox" }],
    fx: [{ type: "orbit", when: "behind", n: 2, r0: 0.42, r1: 0.5, speed: 0.06, size: 0.01, alpha: 0.18 }],
  },
  think: {
    eye: "pill", blink: 3.6, wave: "float", pose: P({ eY: -0.018 }), lean: 0,
    drift: { x: 0.034, y: 0.04, speed: 0.55 },
    props: [],
    fx: [
      { type: "thoughts", when: "behind", n: 3, r0: 0.42, r1: 0.56, speed: 0.55, size: 0.018, alpha: 0.65 },
      { type: "glyphs", when: "front", chars: ["·", "•"], n: 4, r0: 0.4, r1: 0.5, size: 0.04, alpha: 0.5 },
    ],
  },
  plan: {
    eye: "pill", blink: 0, wave: "nod", pose: P({ eY: 0.01, eX: 0.03 }), lean: 0.018,
    drift: { x: 0.05, y: 0.035, speed: 0.7 },
    props: [{ type: "checklist", mode: "fill", rows: 3 }],
    fx: [{ type: "corners", when: "behind", r: 0.46, speed: 0.4, alpha: 0.28 }],
  },
  compact: {
    eye: "narrow", blink: 4.4, wave: "compact", pose: P({ eW: 0.155, eH: 0.26 }), lean: 0,
    props: [{ type: "stack" }],
    fx: [
      { type: "edges", when: "front", r0: 0.46, r1: 0.37, speed: 1.2, alpha: 0.55 },
      { type: "orbit", when: "behind", n: 2, r0: 0.42, r1: 0.5, speed: -0.4, size: 0.012, alpha: 0.3 },
    ],
  },
  type: {
    eye: "narrow", blink: 0, wave: "type", pose: P({ eW: 0.155, eH: 0.26, eY: 0.045 }), lean: 0,
    drift: { x: 0.006, y: 0.008, speed: 3.4 },
    props: [{ type: "keys", w: 0.36, y: 0.33, n: 6 }],
    fx: [{ type: "orbit", when: "behind", n: 3, r0: 0.42, r1: 0.5, speed: 0.2, size: 0.008, alpha: 0.25 }],
  },
  read: {
    eye: "pill", blink: 0, wave: "read", pose: P({ eX: 0.028, eY: 0.006 }), lean: 0.02,
    drift: { x: 0.008, y: 0.05, speed: 0.55 },
    props: [{ type: "page", h: 0.2, mode: "read" }],
    fx: [{ type: "orbit", when: "behind", n: 2, r0: 0.44, r1: 0.5, speed: 0.15, size: 0.01, alpha: 0.25 }],
  },
  find: {
    eye: "squint", blink: 0, wave: "ping", pose: P({ eW: 0.17, eH: 0.2, eX: 0.02 }), lean: 0.012,
    drift: { x: 0.05, y: 0.04, speed: 1.1 },
    props: [{ type: "lens" }],
    fx: [
      { type: "grid", when: "front", n: 5, speed: 0.45, alpha: 0.55 },
      { type: "orbit", when: "behind", n: 2, r0: 0.44, r1: 0.52, speed: 0.2, size: 0.01, alpha: 0.25 },
    ],
  },
  web: {
    eye: "squint", blink: 0, wave: "ping", pose: P({ eW: 0.17, eH: 0.2, eY: 0.025 }), lean: 0,
    props: [{ type: "browser" }],
    fx: [{ type: "orbit", when: "behind", n: 5, r0: 0.4, r1: 0.54, speed: 0.65, size: 0.013, alpha: 0.5 }],
  },
  check: {
    eye: "squint", blink: 3.2, wave: "pulse", pose: P({ eW: 0.17, eH: 0.2, eX: 0.022 }), lean: 0.018,
    props: [{ type: "page", h: 0.2, mode: "check" }],
    fx: [{ type: "aura", when: "behind", alpha: 0.2 }],
  },
  warn: {
    eye: "squint", blink: 4, wave: "sway", pose: P({ eW: 0.17, eH: 0.2, eX: 0.015 }), lean: 0.006,
    props: [{ type: "badge", ch: "!", x: 0.35, y: -0.16, size: 0.11 }],
    fx: [{ type: "aura", when: "behind", alpha: 0.26 }],
  },
  recheck: {
    eye: "pill", blink: 3, wave: "breathe", pose: P({ eW: 0.14, eH: 0.3 }), lean: 0,
    props: [{ type: "badge", ch: "↺", x: 0.35, y: -0.15, size: 0.1 }],
    fx: [{ type: "corners", when: "behind", r: 0.46, speed: 0.4, alpha: 0.25 }],
  },
  verify: {
    eye: "squint", blink: 4, wave: "nod", pose: P({ eW: 0.17, eH: 0.2, eX: 0.03 }), lean: 0.02,
    drift: { x: 0.03, y: 0.008, speed: 0.35 },
    props: [{ type: "checklist", mode: "scan", rows: 3 }],
    fx: [{ type: "corners", when: "behind", r: 0.46, speed: 0.3, alpha: 0.2 }],
  },
  edit: {
    eye: "narrow", blink: 3.4, wave: "edit", pose: P({ eW: 0.155, eH: 0.28, eX: 0.025 }), lean: 0.02,
    drift: { x: 0.016, y: 0.01, speed: 1.7 },
    props: [{ type: "page", h: 0.2, mode: "edit" }],
    fx: [{ type: "orbit", when: "behind", n: 3, r0: 0.42, r1: 0.5, speed: 0.5, size: 0.009, alpha: 0.3 }],
  },
  create: {
    eye: "pill", blink: 0, wave: "nod", pose: P({ eY: 0.012 }), lean: 0.008,
    props: [{ type: "pencil" }],
    fx: [{ type: "glyphs", when: "front", chars: ["✦"], n: 1, r0: 0.47, r1: 0.47, size: 0.05, alpha: 0.9, pulse: true }],
  },
  run: {
    eye: "pill", blink: 2.2, wave: "hop", pose: P(), lean: 0,
    props: [],
    fx: [
      { type: "speed", when: "behind", n: 7, r0: 0.4, r1: 0.62, speed: 1.6, alpha: 0.45 },
      { type: "dust", when: "front", n: 4, alpha: 0.35 },
    ],
  },
  tests: {
    eye: "pill", blink: 1.4, wave: "pulse", pose: P({ eY: -0.006 }), lean: 0.006,
    props: [{ type: "checklist", mode: "alt", rows: 3 }],
    fx: [{ type: "aura", when: "behind", alpha: 0.18 }],
  },
  ask: {
    eye: "wide", blink: 5.4, wave: "tilt", pose: P({ eW: 0.14, eH: 0.44, rot: -0.02, eX: 0.012 }), lean: -0.004,
    props: [{ type: "bubble", ch: "?" }],
    fx: [{ type: "orbit", when: "behind", n: 2, r0: 0.44, r1: 0.5, speed: 0.2, size: 0.01, alpha: 0.25 }],
  },
  done: {
    eye: "happy", blink: 0, wave: "hop", pose: P({ eW: 0.2, eH: 0.14 }), lean: 0,
    props: [{ type: "check" }],
    fx: [
      { type: "sparks", when: "front", n: 9, alpha: 0.95, burst: true },
      { type: "aura", when: "behind", alpha: 0.24 },
    ],
  },
  update: {
    eye: "happy", blink: 0, wave: "float", pose: P({ eW: 0.2, eH: 0.14 }), lean: 0,
    props: [{ type: "arrowUp" }],
    fx: [{ type: "sparks", when: "front", n: 7, alpha: 0.9, burst: true, rise: true }],
  },
  error: {
    eye: "sad", blink: 0, wave: "sag", pose: P({ eW: 0.14, eH: 0.3, sy: 0.96, y: 0.02, tilt: 0.18, eY: 0.02 }), lean: 0,
    props: [{ type: "crack" }],
    fx: [
      { type: "embers", when: "front", n: 7, alpha: 0.8 },
      { type: "aura", when: "behind", alpha: 0.28 },
    ],
  },
};

export interface BodyDyn {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rot: number;
}

export function beat(t: number, period: number, peak = 0.1): number {
  const k = (t % period) / period;
  if (k < peak) return k / peak;
  return Math.max(0, 1 - (k - peak) / 0.55);
}

export function bodyDynamics(kind: Wave, t: number): BodyDyn {
  const o: BodyDyn = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
  if (!kind) return o;
  let b = 0;
  switch (kind) {
    case "hop":
      b = beat(t, 1.5, 0.1);
      o.dy = -0.12 * b; o.sy = 1 + 0.09 * b; o.sx = 1 - 0.06 * b;
      o.dx = 0.01 * b; o.rot = -0.03 * b;
      break;
    case "nod":
      b = beat(t, 3, 0.16);
      o.dy = -0.03 * b; o.sy = 1 - 0.022 * b; o.rot = 0.015 * b;
      break;
    case "sag":
      o.dy = 0.016 + Math.sin(t * 1.4) * 0.008;
      o.sy = 1 - 0.03 - Math.sin(t * 1.4) * 0.006;
      o.rot = Math.sin(t * 0.7) * 0.015;
      break;
    case "tilt":
      o.rot = Math.sin(t * 2.4) * 0.06; o.dx = Math.sin(t * 2.4) * 0.012;
      break;
    case "sway":
      o.rot = Math.sin(t * 1.45) * 0.04; o.dx = Math.sin(t * 1.45) * 0.01;
      break;
    case "float":
      o.dy = Math.sin(t * 1.15) * 0.028; o.sy = 1 + Math.sin(t * 1.15) * 0.01;
      o.rot = Math.sin(t * 0.9) * 0.015;
      break;
    case "type":
      b = Math.pow(Math.max(0, Math.sin(t * 6.4)), 8);
      o.dy = -0.022 * b; o.sy = 1 - 0.045 * b; o.sx = 1 + 0.03 * b; o.rot = 0.02 * b;
      break;
    case "ping":
      b = beat(t, 2.6, 0.18);
      o.dy = -0.01 * b; o.sx = 1 + 0.03 * b; o.sy = 1 + 0.03 * b;
      break;
    case "pulse":
      b = beat(t, 0.9, 0.12);
      o.dy = -0.012 * b; o.sx = 1 + 0.03 * b; o.sy = 1 - 0.02 * b;
      break;
    case "compact":
      b = beat(t, 2.4, 0.08);
      o.sx = 1 - 0.32 * b; o.sy = 1 + 0.06 * b;
      break;
    case "breathe":
      o.sy = 1 + Math.sin(t * 1.1) * 0.012;
      o.dy = Math.sin(t * 1.1) * 0.006;
      break;
    case "read":
      b = beat(t, 2.2, 0.35);
      o.dy = -0.02 * b; o.rot = 0.02 * b; o.sy = 1 - 0.015 * b;
      break;
    case "edit":
      o.rot = 0.012 + Math.sin(t * 2.7) * 0.018;
      o.dy = -0.012 * Math.pow(Math.max(0, Math.sin(t * 2.7)), 4);
      break;
  }
  return o;
}

export function blinkFactor(t: number, period: number, phase: number): number {
  if (!period) return 1;
  const k = (t + phase) % period;
  const d = 0.14;
  if (k > period - d) {
    const x = (k - (period - d)) / d;
    return 1 - Math.sin(x * Math.PI) * 0.94;
  }
  return 1;
}
