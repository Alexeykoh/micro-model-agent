// Canvas renderer for MMART: body, eyes and the two effect layers. The front
// layer (props + effects) is clipped by an even-odd hole of the body silhouette,
// so nothing can be painted over the face.
import type { FaceState } from "./loader-states.js";
import type { FaceColors, Pose } from "./mascot-types.js";
import type { StateCfg } from "./mascot-pose.js";
import { bodyDynamics, blinkFactor } from "./mascot-pose.js";
import { drawFx } from "./mascot-fx.js";
import { drawProp } from "./mascot-props.js";
import { clamp, lerp, mixHex, rgba, seedAt, smooth, TAU } from "./mascot-util.js";

const BODY = 0.5;

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  layer: HTMLCanvasElement | null;
  w: number;
  h: number;
  dpr: number;
  cfg: StateCfg;
  prevCfg: StateCfg;
  colors: FaceColors;
  prevColors: FaceColors;
  state: FaceState;
  prevState: FaceState;
  pose: Pose;
  time: number;
  entry: number;
  seed: number;
  prevSeed: number;
  mix: number;
  pulse: number;
  trackX: number;
  trackY: number;
  blinkOnce: number;
  radius: number;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

function eye(
  ctx: CanvasRenderingContext2D,
  shape: string,
  x: number,
  y: number,
  w: number,
  h: number,
  blink: number,
  tilt: number,
  color: string,
): void {
  if (shape === "happy") {
    const hw = w * 0.74;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, h * 0.3);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - hw / 2, y + h * 0.2);
    ctx.quadraticCurveTo(x, y - h * 1.05, x + hw / 2, y + h * 0.2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const hh = (shape === "sleep" ? h * 0.22 : h) * blink;
  ctx.save();
  ctx.translate(x, y);
  if (tilt) ctx.rotate(tilt);
  rounded(ctx, -w / 2, -hh / 2, w, Math.max(2, hh), w / 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function blend(a: FaceColors, b: FaceColors, t: number): FaceColors {
  return {
    face: mixHex(a.face, b.face, t),
    eye: mixHex(a.eye, b.eye, t),
    edge: mixHex(a.edge, b.edge, t),
    accent: mixHex(a.accent, b.accent, t),
    isLight: b.isLight,
  };
}

export function renderFace(s: DrawInput): void {
  const { ctx, w, h, dpr } = s;
  if (!w || !h) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const u = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const m = s.mix >= 1 ? 1 : smooth(s.mix);
  const col = m >= 1 ? s.colors : blend(s.prevColors, s.colors, m);
  const prev = s.prevCfg;
  const cfg = s.cfg;
  const showProps = u >= 90;
  const showFx = u >= 50;
  const p = s.pose;

  const env = {
    ctx, cx, cy, u, w, h, t: s.time, entry: s.entry,
    seed: s.seed, accent: col.accent, colors: col,
  };

  const paint = (stateKey: FaceState, seed: number, colors: FaceColors, fade: number, behind: boolean): void => {
    const layer = s.layer;
    if (!layer) return;
    const lctx = layer.getContext("2d");
    if (!lctx) return;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    const g = {
      ctx: lctx, cx, cy, u, w, h, t: s.time, entry: s.entry,
      seed, accent: colors.accent, colors,
    };
    const stateCfg = stateKey === s.state ? cfg : prev;
    if (behind) {
      if (!showFx) return;
      for (const fx of stateCfg.fx) {
        if (fx.when !== "front") drawFx(fx.type, g, fx);
      }
    } else {
      if (showProps) for (const prop of stateCfg.props) drawProp(prop.type, g, prop);
      if (showFx) for (const fx of stateCfg.fx) {
        if (fx.when === "front") drawFx(fx.type, g, fx);
      }
    }
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.drawImage(layer, 0, 0, w, h);
    ctx.restore();
  };

  if (showFx) {
    if (m >= 1) {
      for (const fx of cfg.fx) {
        if (fx.when !== "front") drawFx(fx.type, env, fx);
      }
    } else {
      const layer = s.layer;
      if (layer) {
        paint(s.prevState, s.prevSeed, s.prevColors, 1 - m, true);
        if (m > 0) paint(s.state, s.seed, s.colors, m, true);
      }
    }
  }

  const dCur = bodyDynamics(cfg.wave, s.time);
  const dPrev = m < 1 ? bodyDynamics(prev.wave, s.time) : dCur;
  const dyn = m < 1
    ? {
        dx: lerp(dPrev.dx, dCur.dx, m),
        dy: lerp(dPrev.dy, dCur.dy, m),
        sx: lerp(dPrev.sx, dCur.sx, m),
        sy: lerp(dPrev.sy, dCur.sy, m),
        rot: lerp(dPrev.rot, dCur.rot, m),
      }
    : dCur;
  const lean = m < 1 ? lerp(prev.lean, cfg.lean, m) : cfg.lean;
  const pulse = s.pulse * s.pulse;
  const shapeScale = s.radius === 0 ? 0.9 : 1;
  const sx = p.sx * dyn.sx * (1 + 0.055 * pulse);
  const sy = p.sy * dyn.sy * (1 - 0.07 * pulse);
  const rot = p.rot + dyn.rot + lean * 0.8;
  const bx = cx + (dyn.dx + lean) * u;
  const by = cy + (p.y + dyn.dy) * u;
  const bw = u * BODY * sx * shapeScale;
  const bh = u * BODY * sy * shapeScale;
  const rad = Math.min(bw, bh) * s.radius;

  const shadow = ctx.createRadialGradient(bx, by + bh * 0.55, 1, bx, by + bh * 0.55, bw * 0.75);
  shadow.addColorStop(0, col.isLight ? "rgba(27,29,34,.20)" : "rgba(0,0,0,.45)");
  shadow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(bx, by + bh * 0.55, bw * 0.72, bh * 0.22, 0, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(rot);
  rounded(ctx, -bw / 2, -bh / 2, bw, bh, rad);
  ctx.fillStyle = col.face;
  ctx.fill();
  ctx.strokeStyle = rgba(col.edge, 0.75);
  ctx.lineWidth = Math.max(1, u * 0.006);
  ctx.stroke();

  ctx.save();
  rounded(ctx, -bw / 2, -bh / 2, bw, bh, rad);
  ctx.clip();
  const hl = ctx.createLinearGradient(0, -bh / 2, 0, bh * 0.1);
  hl.addColorStop(0, "rgba(255,255,255,.16)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hl;
  ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
  ctx.restore();

  const bs = u * BODY;
  const dA = prev.drift;
  const dB = cfg.drift;
  const dax = dA ? dA.x * bs * Math.sin(s.time * dA.speed * 2.1 + 0.6) : 0;
  const day = dA ? dA.y * bs * Math.cos(s.time * dA.speed * 1.7) : 0;
  const dbx = dB ? dB.x * bs * Math.sin(s.time * dB.speed * 2.1 + 0.6) : 0;
  const dby = dB ? dB.y * bs * Math.cos(s.time * dB.speed * 1.7) : 0;
  const ex = p.eX * bs + lerp(dax, dbx, m) + s.trackX * bs * 0.16;
  const ey = (p.eY - 0.06) * bs + lerp(day, dby, m) + s.trackY * bs * 0.16;
  const spread = p.spread * bs;
  const eyeW = Math.max(u * 0.03, p.eW * bs);
  const eyeH = Math.max(u * 0.03, p.eH * bs);
  const blinkBase = blinkFactor(s.time, cfg.blink, seedAt(s.seed, 0) * 10);
  const blink = s.blinkOnce > 0 ? 0.12 : blinkBase;
  const wake = cfg.eye === "wake" ? 1 - 0.92 * (1 - smooth(s.entry / 0.9)) : 1;

  if (m < 1 && prev.eye !== cfg.eye) {
    ctx.save();
    ctx.globalAlpha = 1 - m;
    eye(ctx, prev.eye, -spread + ex, ey, eyeW, eyeH, blink * wake, p.tilt, col.eye);
    eye(ctx, prev.eye, spread + ex, ey, eyeW, eyeH, blink * wake, -p.tilt, col.eye);
    ctx.globalAlpha = m;
    eye(ctx, cfg.eye, -spread + ex, ey, eyeW, eyeH, blink * wake, p.tilt, col.eye);
    eye(ctx, cfg.eye, spread + ex, ey, eyeW, eyeH, blink * wake, -p.tilt, col.eye);
    ctx.restore();
  } else {
    eye(ctx, cfg.eye, -spread + ex, ey, eyeW, eyeH, blink * wake, p.tilt, col.eye);
    eye(ctx, cfg.eye, spread + ex, ey, eyeW, eyeH, blink * wake, -p.tilt, col.eye);
  }
  ctx.restore();

  if (!showFx) return;

  const pad = u * 0.014;
  ctx.save();
  ctx.beginPath();
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(rot);
  rounded(ctx, -bw / 2 - pad, -bh / 2 - pad, bw + pad * 2, bh + pad * 2, rad + pad);
  ctx.restore();
  ctx.rect(0, 0, w, h);
  ctx.clip("evenodd");

  if (m >= 1) {
    ctx.globalAlpha = clamp(s.entry / 0.22, 0, 1);
    if (showProps) for (const prop of cfg.props) drawProp(prop.type, env, prop);
    ctx.globalAlpha = 1;
    for (const fx of cfg.fx) {
      if (fx.when === "front") drawFx(fx.type, env, fx);
    }
  } else {
    paint(s.prevState, s.prevSeed, s.prevColors, 1 - m, false);
    if (m > 0) paint(s.state, s.seed, s.colors, m, false);
  }
  ctx.restore();
}
