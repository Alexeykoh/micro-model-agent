// Props for reading, planning, browsing and status. Each prop is the thing the
// mascot is operating; the renderer clips it to the area outside the body.
import type { Env, PropCfg } from "./mascot-types.js";
import { check, cross, panel, type PropFn } from "./mascot-prop-util.js";
import { PROPS_WORK } from "./mascot-props-work.js";
import { easeOut, rgba } from "./mascot-util.js";

const PROPS: Record<string, PropFn> = {
  ...PROPS_WORK,

  page(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.15;
    const h = u * (c.h ?? 0.2);
    const x = g.cx + u * 0.355 - w / 2;
    const y = g.cy - h / 2;
    panel(ctx, x, y, w, h, u * 0.012, rgba(g.colors.accent, 0.07), rgba(g.colors.accent, 0.28));
    const pad = w * 0.16;
    const lh = h * 0.075;
    const gap = h * 0.07;
    for (let i = 0; i < 4; i++) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = rgba(g.colors.accent, 1);
      ctx.fillRect(x + pad, y + h * 0.17 + i * (lh + gap), w - pad * 2 - (i === 3 ? w * 0.3 : 0), lh);
    }
    ctx.globalAlpha = 1;
    if (c.mode === "read" || c.mode === "scan") {
      const k = (g.t * 0.55) % 1;
      ctx.fillStyle = rgba(g.accent, 0.45);
      ctx.fillRect(x + pad * 0.4, y + h * 0.12 + k * (h * 0.74), w - pad * 0.8, h * 0.05);
    }
    if (c.mode === "edit") {
      const cx = x + w * 0.52;
      const cy = y + h * 0.34;
      ctx.globalAlpha = Math.sin(g.t * 6) > 0.15 ? 1 : 0.2;
      ctx.fillStyle = rgba(g.accent, 1);
      ctx.fillRect(cx, cy, Math.max(1, u * 0.009), h * 0.16);
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = rgba(g.colors.accent, 1);
      ctx.fillRect(x + pad, cy, w * 0.3, h * 0.05);
      ctx.globalAlpha = 1;
    }
    if (c.mode === "check") check(ctx, x + w * 0.6, y + h * 0.82, w * 0.6, g.accent, 0.95);
  },

  checklist(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.15;
    const h = u * 0.21;
    const x = g.cx + u * 0.355 - w / 2;
    const y = g.cy - h / 2;
    panel(ctx, x, y, w, h, u * 0.012, rgba(g.colors.accent, 0.07), rgba(g.colors.accent, 0.28));
    const rows = c.rows ?? 3;
    const rowH = h / (rows + 0.4);
    for (let i = 0; i < rows; i++) {
      const by = y + h * 0.12 + i * rowH;
      const bs = w * 0.2;
      const bx = x + w * 0.1;
      panel(ctx, bx, by, bs, bs, bs * 0.18, null, rgba(g.colors.accent, 0.4));
      const phase = g.t * 0.9 - i * 0.7;
      const pass = c.mode === "alt" ? Math.sin(g.t * 2.2 - i * 1.4) > 0 : Math.sin(phase) > -0.2;
      if (c.mode === "alt") {
        if (Math.sin(g.t * 2.2 - i * 1.4) > 0) check(ctx, bx + bs / 2, by + bs / 2, bs * 1.05, g.accent, 0.95);
        else cross(ctx, bx + bs / 2, by + bs / 2, bs * 0.95, g.colors.accent, 0.85);
      } else if (pass || c.mode === "scan") {
        check(ctx, bx + bs / 2, by + bs / 2, bs * 1.05, g.accent, 0.95);
      }
      ctx.fillStyle = rgba(g.colors.accent, 0.45);
      ctx.fillRect(bx + bs * 1.7, by + bs * 0.36, w * 0.5, Math.max(1, u * 0.006));
    }
    if (c.mode === "scan") {
      const k = (g.t * 0.5) % 1;
      ctx.fillStyle = rgba(g.accent, 0.35);
      ctx.fillRect(x + w * 0.08, y + h * 0.08 + k * (h * 0.8), w * 0.84, h * 0.05);
    }
  },

  browser(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.32;
    const h = u * 0.075;
    const x = g.cx - w / 2;
    const y = g.cy + u * (c.y ?? 0.335) - h / 2;
    panel(ctx, x, y, w, h, h * 0.25, rgba(g.colors.accent, 0.07), rgba(g.colors.accent, 0.26));
    ctx.fillStyle = rgba(g.colors.accent, 0.5);
    for (let i = 0; i < 3; i++) ctx.fillRect(x + w * 0.04 + i * w * 0.05, y + h * 0.16, w * 0.025, h * 0.12);
    ctx.fillStyle = rgba(g.colors.accent, 0.28);
    ctx.fillRect(x + w * 0.24, y + h * 0.14, w * 0.52, h * 0.16);
    const k = (g.t * 0.4) % 1;
    ctx.fillStyle = rgba(g.accent, 0.85);
    ctx.fillRect(x + w * 0.04, y + h * 0.62, w * 0.92 * easeOut(k), h * 0.12);
  },

  lens(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.125;
    const x = g.cx + u * (c.x ?? 0.35) + Math.sin(g.t * 0.7) * u * 0.02;
    const y = g.cy - u * (c.y ?? 0.06) + Math.cos(g.t * 0.52) * u * 0.018;
    const h = s / 2;
    const arm = s * 0.28;
    ctx.save();
    ctx.strokeStyle = rgba(g.accent, 0.85);
    ctx.lineWidth = Math.max(1.5, u * 0.009);
    ctx.lineCap = "round";
    const cs: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sy] of cs) {
      const px = x + sx * h;
      const py = y + sy * h;
      ctx.beginPath();
      ctx.moveTo(px, py - sy * arm);
      ctx.lineTo(px, py);
      ctx.lineTo(px - sx * arm, py);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x - s * 0.2, y);
    ctx.lineTo(x + s * 0.2, y);
    ctx.moveTo(x, y - s * 0.2);
    ctx.lineTo(x, y + s * 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + h * 0.72, y + h * 0.72);
    ctx.lineTo(x + h * 1.35, y + h * 1.35);
    ctx.stroke();
    ctx.restore();
  },

  badge(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const x = g.cx + u * (c.x ?? 0.35);
    const y = g.cy + u * (c.y ?? -0.16);
    ctx.save();
    ctx.globalAlpha = 0.72 + 0.28 * Math.sin(g.t * 2.4);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(u * (c.size ?? 0.1))}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = g.accent;
    ctx.fillText(c.ch ?? "!", x, y);
    ctx.restore();
  },

  bubble(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const w = u * 0.15;
    const h = u * 0.105;
    const x = g.cx + u * 0.36;
    const y = g.cy - u * 0.18;
    panel(ctx, x - w / 2, y - h / 2, w, h, h * 0.35, rgba(g.accent, 0.16), rgba(g.accent, 0.5));
    ctx.beginPath();
    ctx.moveTo(x - w * 0.22, y + h * 0.38);
    ctx.lineTo(x - w * 0.1, y + h * 0.72);
    ctx.lineTo(x + w * 0.04, y + h * 0.38);
    ctx.closePath();
    ctx.fillStyle = rgba(g.accent, 0.16);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `700 ${Math.round(u * 0.085)}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = g.accent;
    ctx.fillText(c.ch ?? "?", x, y);
  },
};

export function drawProp(name: string, g: Env, c: PropCfg): void {
  const fn = PROPS[name];
  if (fn) fn(g, c);
}
