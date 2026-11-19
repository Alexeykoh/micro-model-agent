// Props for input, creation, progress and status states.
import type { Env, PropCfg } from "./mascot-types.js";
import { panel, type PropFn } from "./mascot-prop-util.js";
import { clamp, easeOut, lerp, rgba } from "./mascot-util.js";

export const PROPS_WORK: Record<string, PropFn> = {
  keys(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * (c.w ?? 0.36);
    const h = u * 0.045;
    const x0 = g.cx - w / 2;
    const y0 = g.cy + u * (c.y ?? 0.33);
    panel(ctx, x0, y0 - h / 2, w, h, h * 0.4, rgba(g.colors.accent, 0.1), rgba(g.colors.accent, 0.3));
    const n = c.n ?? 6;
    const gap = w * 0.035;
    const kw = (w - gap * (n + 1)) / n;
    for (let i = 0; i < n; i++) {
      const tap = Math.pow(Math.max(0, Math.sin(g.t * 6.4 + i * 1.1)), 10);
      const x = x0 + gap + i * (kw + gap);
      panel(
        ctx, x, y0 - h * 0.34 - tap * h * 0.22, kw, h * 0.68, h * 0.24,
        rgba(g.colors.accent, 0.35 + tap * 0.55), null,
      );
    }
  },

  check(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.115;
    const x = g.cx + u * 0.35;
    const y = g.cy - u * 0.15;
    const k = clamp((g.t % 3.4) / 0.6, 0, 1);
    const p1: [number, number] = [x - s * 0.5, y];
    const p2: [number, number] = [x - s * 0.08, y + s * 0.4];
    const p3: [number, number] = [x + s * 0.62, y - s * 0.55];
    const a = Math.min(1, k * 2);
    const b = Math.max(0, k * 2 - 1);
    ctx.save();
    ctx.strokeStyle = rgba(g.accent, 0.95);
    ctx.lineWidth = Math.max(2, u * 0.016);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(lerp(p1[0], p2[0], a), lerp(p1[1], p2[1], a));
    if (b > 0) ctx.lineTo(lerp(p2[0], p3[0], b), lerp(p2[1], p3[1], b));
    ctx.stroke();
    ctx.restore();
  },

  arrowUp(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.115;
    const x = g.cx + u * 0.35;
    const y = g.cy - u * 0.14 + Math.sin(g.t * 1.2) * u * 0.008;
    const k = clamp((g.t % 3) / 0.55, 0, 1);
    ctx.save();
    ctx.strokeStyle = rgba(g.accent, 0.95);
    ctx.lineWidth = Math.max(2, u * 0.016);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.5);
    ctx.lineTo(x, y + s * 0.5 - s * k);
    if (k > 0.6) {
      const kk = (k - 0.6) / 0.4;
      ctx.moveTo(x - s * 0.34 * kk, y - s * 0.5 + s * 0.34 * kk);
      ctx.lineTo(x, y - s * 0.5);
      ctx.lineTo(x + s * 0.34 * kk, y - s * 0.5 + s * 0.34 * kk);
    }
    ctx.stroke();
    ctx.restore();
  },

  crack(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.34;
    const y = g.cy - u * 0.29;
    const x0 = g.cx - w / 2;
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.25 * Math.sin(g.t * 3);
    ctx.strokeStyle = rgba(g.accent, 0.9);
    ctx.lineWidth = Math.max(1.5, u * 0.012);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    for (let i = 1; i <= 7; i++) {
      ctx.lineTo(x0 + (w * i) / 7, y + (i % 2 ? -1 : 1) * u * 0.02);
    }
    ctx.stroke();
    ctx.restore();
  },

  stopBox(g, c) {
    const u = g.u;
    const s = u * 0.075;
    const x = g.cx + u * (c.x ?? 0.35);
    const y = g.cy - u * 0.145;
    panel(g.ctx, x - s / 2, y - s / 2, s, s, s * 0.16, rgba(g.colors.accent, 0.85), null);
  },

  hourglass(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.095;
    const x = g.cx + u * (c.x ?? 0.35);
    const y = g.cy - u * 0.07;
    ctx.save();
    ctx.strokeStyle = rgba(g.accent, 0.8);
    ctx.lineWidth = Math.max(1.5, u * 0.008);
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x - s / 2, y - s / 2);
    ctx.lineTo(x + s / 2, y - s / 2);
    ctx.lineTo(x - s / 2, y + s / 2);
    ctx.lineTo(x + s / 2, y + s / 2);
    ctx.closePath();
    ctx.stroke();
    const k = (g.t * 0.45) % 1;
    ctx.fillStyle = rgba(g.accent, 0.55);
    ctx.beginPath();
    ctx.moveTo(x - s * 0.2, y + s * 0.4);
    ctx.lineTo(x + s * 0.2, y + s * 0.4);
    ctx.lineTo(x, y + s * 0.4 - s * 0.5 * (1 - k));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  bar(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.3;
    const h = u * 0.018;
    const x = g.cx - w / 2;
    const y = g.cy + u * (c.y ?? 0.33) - h / 2;
    panel(ctx, x, y, w, h, h / 2, rgba(g.colors.accent, 0.12), null);
    const k = (g.t * 0.45) % 1;
    ctx.fillStyle = rgba(g.accent, 0.9);
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(h, w * k), h, h / 2);
    ctx.fill();
  },

  pencil(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.1;
    const k = (g.t * 0.55) % 1;
    const bx = g.cx + u * 0.3;
    const by = g.cy + u * 0.1;
    ctx.save();
    ctx.strokeStyle = rgba(g.colors.accent, 0.5);
    ctx.lineWidth = Math.max(1, u * 0.008);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + u * 0.13 * easeOut(k), by);
    ctx.stroke();
    ctx.translate(bx + u * 0.13 * easeOut(k), by - u * 0.03);
    ctx.rotate(-0.55);
    ctx.fillStyle = rgba(g.accent, 0.95);
    ctx.fillRect(-s * 0.12, -s * 0.45, s * 0.24, s * 0.7);
    ctx.beginPath();
    ctx.moveTo(-s * 0.12, s * 0.25);
    ctx.lineTo(0, s * 0.5);
    ctx.lineTo(s * 0.12, s * 0.25);
    ctx.closePath();
    ctx.fillStyle = rgba(g.colors.accent, 0.95);
    ctx.fill();
    ctx.restore();
  },

  stack(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.15;
    const x = g.cx + u * 0.355 - w / 2;
    const k = (g.t * 0.85) % 1;
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * (1 - k) * u * 0.05;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = rgba(g.colors.accent, 1);
      ctx.fillRect(x, g.cy + off - u * 0.005, w, Math.max(1, u * 0.009));
    }
    ctx.globalAlpha = 1;
  },
};
