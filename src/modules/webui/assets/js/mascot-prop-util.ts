// Drawing primitives shared by the mascot prop groups.
import type { Env, PropCfg } from "./mascot-types.js";

export type PropFn = (g: Env, c: PropCfg) => void;

export function panel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | null,
  stroke: string | null,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.06);
    ctx.stroke();
  }
}

export function check(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  color: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.45, cy);
  ctx.lineTo(cx - s * 0.08, cy + s * 0.4);
  ctx.lineTo(cx + s * 0.55, cy - s * 0.52);
  ctx.stroke();
  ctx.restore();
}

export function cross(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  color: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.2);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.36, cy - s * 0.36);
  ctx.lineTo(cx + s * 0.36, cy + s * 0.36);
  ctx.moveTo(cx + s * 0.36, cy - s * 0.36);
  ctx.lineTo(cx - s * 0.36, cy + s * 0.36);
  ctx.stroke();
  ctx.restore();
}
