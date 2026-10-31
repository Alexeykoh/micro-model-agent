// Ambient effects drawn around the mascot. Everything front-facing runs under
// the body-shaped even-odd clip in the renderer, so nothing can cover the face.
import type { Env, FxCfg } from "./mascot-types.js";
import { TAU, clamp, dot, lerp, rgba, seedAt } from "./mascot-util.js";

export type FxFn = (g: Env, c: FxCfg) => void;

const FX: Record<string, FxFn> = {
  orbit(g, c) {
    const n = c.n ?? 3;
    for (let i = 0; i < n; i++) {
      const s = seedAt(g.seed, i);
      const a = g.t * (c.speed ?? 0.3) * (i % 2 ? -1 : 1) + (i * TAU) / n + s * TAU;
      const r = g.u * lerp(c.r0 ?? 0.4, c.r1 ?? 0.5, seedAt(g.seed, i + 31));
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r * 0.92;
      const al = (c.alpha ?? 0.4) * (0.55 + 0.45 * Math.sin(g.t * 2.1 + i * 1.7));
      dot(g.ctx, x, y, g.u * (c.size ?? 0.012) * (0.7 + 0.6 * s), g.accent, clamp(al, 0, 1));
    }
  },

  thoughts(g, c) {
    const n = c.n ?? 3;
    for (let i = 0; i < n; i++) {
      const s = seedAt(g.seed, i + 7);
      const k = (g.t * (c.speed ?? 0.5) + i / n + s) % 1;
      const a = -Math.PI / 2 + Math.sin(k * TAU + i) * 0.55 + (i - 1) * 0.32;
      const r = g.u * lerp(c.r0 ?? 0.42, c.r1 ?? 0.56, k);
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r * 0.9 - k * g.u * 0.04;
      dot(g.ctx, x, y, g.u * (c.size ?? 0.018) * (0.6 + k * 0.8), g.accent, (c.alpha ?? 0.6) * Math.sin(Math.PI * k));
    }
  },

  grid(g, c) {
    const ctx = g.ctx;
    const n = c.n ?? 5;
    ctx.save();
    ctx.strokeStyle = rgba(g.accent, 1);
    ctx.lineWidth = Math.max(1, g.u * 0.008);
    ctx.lineCap = "round";
    for (let iy = 0; iy < n; iy++) {
      for (let ix = 0; ix < n; ix++) {
        const x = ((ix + 0.5) / n) * g.w;
        const y = ((iy + 0.5) / n) * g.h;
        if (Math.hypot(x - g.cx, y - g.cy) < g.u * 0.3) continue;
        const wave = Math.cos((x / g.w) * Math.PI * 3 - g.t * (c.speed ?? 0.45) * 3);
        ctx.globalAlpha = (c.alpha ?? 0.5) * (0.16 + 0.84 * Math.max(0, wave));
        const s = g.u * 0.012;
        ctx.beginPath();
        ctx.moveTo(x - s, y);
        ctx.lineTo(x + s, y);
        ctx.moveTo(x, y - s);
        ctx.lineTo(x, y + s);
        ctx.stroke();
      }
    }
    ctx.restore();
  },

  corners(g, c) {
    const ctx = g.ctx;
    const r = g.u * (c.r ?? 0.44);
    const len = g.u * 0.038;
    ctx.save();
    ctx.strokeStyle = rgba(g.accent, 1);
    ctx.lineWidth = Math.max(1, g.u * 0.011);
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r;
      const on = 0.3 + 0.7 * Math.max(0, Math.sin(g.t * (c.speed ?? 0.5) * 2 + i * 1.2));
      ctx.globalAlpha = (c.alpha ?? 0.4) * on;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x - dy * len, y + dx * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dy * len, y - dx * len);
      ctx.stroke();
    }
    ctx.restore();
  },

  aura(g, c) {
    const ctx = g.ctx;
    const R = g.u * 0.64;
    const grad = ctx.createRadialGradient(g.cx, g.cy, g.u * 0.22, g.cx, g.cy, R);
    grad.addColorStop(0, rgba(g.accent, 0));
    grad.addColorStop(0.5, rgba(g.accent, (c.alpha ?? 0.2) * 0.55));
    grad.addColorStop(1, rgba(g.accent, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, g.w, g.h);
  },

  scan(g, c) {
    const ctx = g.ctx;
    for (let side = -1; side <= 1; side += 2) {
      const x = g.cx + side * g.u * (c.x ?? 0.36);
      const k = (g.t * (c.speed ?? 0.3) + (side > 0 ? 0.5 : 0)) % 1;
      const y = g.cy - g.u * 0.22 + k * g.u * 0.44;
      ctx.globalAlpha = (c.alpha ?? 0.5) * (0.35 + 0.65 * Math.sin(Math.PI * k));
      ctx.fillStyle = rgba(g.colors.accent, 1);
      const h = g.u * 0.13;
      ctx.beginPath();
      ctx.roundRect(x - (g.u * (c.size ?? 0.018)) / 2, y - h / 2, g.u * (c.size ?? 0.018), h, g.u * 0.01);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  },

  glyphs(g, c) {
    const ctx = g.ctx;
    const chars = c.chars ?? ["·"];
    const n = c.n ?? 1;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(g.u * (c.size ?? 0.05))}px ui-monospace, Consolas, monospace`;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * TAU + (n === 1 ? 0.5 : 0);
      const r = g.u * lerp(c.r0 ?? 0.4, c.r1 ?? 0.4, seedAt(g.seed, i + 3));
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r + (c.rise ? Math.sin(g.t * 1.2 + i) * g.u * Number(c.rise) : 0);
      const al = (c.alpha ?? 0.7) * (c.pulse ? 0.55 + 0.45 * Math.sin(g.t * 2.6 + i * 1.9) : 0.75);
      ctx.globalAlpha = clamp(al, 0, 1);
      ctx.fillStyle = g.accent;
      ctx.fillText(chars[i % chars.length], x, y);
    }
    ctx.restore();
  },

  edges(g, c) {
    const ctx = g.ctx;
    const k = (g.t * (c.speed ?? 1)) % 1;
    const pos = g.u * lerp(c.r0 ?? 0.46, c.r1 ?? 0.37, k);
    const len = g.u * 0.18;
    ctx.save();
    ctx.strokeStyle = rgba(g.colors.accent, 1);
    ctx.lineWidth = Math.max(1.5, g.u * 0.012);
    ctx.lineCap = "round";
    for (let side = -1; side <= 1; side += 2) {
      ctx.globalAlpha = (c.alpha ?? 0.5) * (1 - k) * 0.9;
      const x = g.cx + side * pos;
      ctx.beginPath();
      ctx.moveTo(x, g.cy - len / 2);
      ctx.lineTo(x, g.cy + len / 2);
      ctx.stroke();
    }
    ctx.restore();
  },

  speed(g, c) {
    const ctx = g.ctx;
    const n = c.n ?? 6;
    ctx.save();
    ctx.strokeStyle = rgba(g.colors.accent, 1);
    ctx.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + seedAt(g.seed, i) * 0.5;
      const k = (g.t * (c.speed ?? 1.4) + i * 0.13) % 1;
      const r1 = g.u * lerp(c.r0 ?? 0.4, c.r1 ?? 0.6, k);
      const r0 = r1 - g.u * 0.05;
      ctx.globalAlpha = (c.alpha ?? 0.4) * Math.sin(Math.PI * k);
      ctx.lineWidth = Math.max(1, g.u * 0.009);
      ctx.beginPath();
      ctx.moveTo(g.cx + Math.cos(a) * r0, g.cy + Math.sin(a) * r0);
      ctx.lineTo(g.cx + Math.cos(a) * r1, g.cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  },

  dust(g, c) {
    const n = c.n ?? 4;
    const b = Math.max(0, 1 - ((g.t % 1.5) / 1.5 - 0.1) / 0.55);
    for (let i = 0; i < n; i++) {
      const s = seedAt(g.seed, i + 11);
      const x = g.cx + (s - 0.5) * g.u * 0.34;
      const y = g.cy + g.u * 0.36 + b * g.u * (0.02 + s * 0.03);
      dot(g.ctx, x, y, g.u * (0.008 + s * 0.01), g.colors.accent, (c.alpha ?? 0.3) * b);
    }
  },

  sparks(g, c) {
    const ctx = g.ctx;
    const n = c.n ?? 8;
    const burst = clamp(1 - g.entry / 1.15, 0, 1);
    ctx.save();
    ctx.globalCompositeOperation = g.colors.isLight ? "source-over" : "lighter";
    for (let i = 0; i < n; i++) {
      const s = seedAt(g.seed, i + 17);
      const a = (i / n) * TAU + s * 0.7;
      const dist = g.u * (0.36 + (1 - burst) * (0.14 + s * 0.14));
      const y =
        g.cy +
        Math.sin(a) * dist * 0.9 -
        (c.rise ? (1 - burst) * g.u * 0.12 : 0) +
        (c.rise ? 0 : Math.sin(g.t * 1.4 + i) * g.u * 0.006);
      const x = g.cx + Math.cos(a) * dist;
      const tw = 0.5 + 0.5 * Math.sin(g.t * 3 + i * 2.1);
      dot(ctx, x, y, g.u * (0.008 + s * 0.008), g.accent, (c.alpha ?? 0.9) * burst * (0.6 + 0.4 * tw));
    }
    ctx.restore();
  },

  embers(g, c) {
    const n = c.n ?? 6;
    for (let i = 0; i < n; i++) {
      const s = seedAt(g.seed, i + 23);
      const k = (g.t * 0.28 + i / n + s * 0.2) % 1;
      const a = -Math.PI / 2 + (s - 0.5) * 2.2 + Math.sin(g.t * 0.8 + i) * 0.12;
      const r = g.u * (0.38 + (1 - k) * 0.18);
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r + k * g.u * 0.16;
      dot(g.ctx, x, y, g.u * (0.007 + s * 0.006), g.accent, (c.alpha ?? 0.8) * (1 - k) * 0.9);
    }
  },
};

export function drawFx(name: string, g: Env, c: FxCfg): void {
  const fn = FX[name];
  if (fn) fn(g, c);
}
