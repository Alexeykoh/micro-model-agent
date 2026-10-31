// src/modules/webui/assets/js/loader-states.ts
var FACE_CLASS = {
  idle: "c-dim track poke blink",
  think: "c-active st-think blink",
  read: "c-recon st-read",
  find: "c-recon st-find squint",
  web: "c-recon st-web squint",
  edit: "c-mutate st-edit narrow",
  type: "c-active st-type narrow",
  create: "c-mutate st-create",
  run: "c-exec st-run",
  tests: "c-exec st-tests",
  compact: "c-active st-compact",
  plan: "c-active st-plan",
  ask: "c-warn st-ask wide",
  done: "c-ok st-done happy celebrate",
  error: "c-err st-error sad",
  stop: "c-dim st-stop sleep",
  queued: "c-dim st-queued blink",
  boot: "c-dim st-boot",
  load: "c-dim st-load",
  update: "c-ok st-update happy",
  check: "c-recon st-check squint",
  warn: "c-warn st-warn squint",
  recheck: "c-recon st-recheck squint",
  verify: "c-recon st-verify squint"
};

// src/modules/webui/assets/js/mascot-pose.ts
function P(o = {}) {
  return {
    sx: 1,
    sy: 1,
    y: 0,
    rot: 0,
    eX: 0,
    eY: 0,
    eW: 0.14,
    eH: 0.34,
    spread: 0.16,
    tilt: 0,
    ...o
  };
}
var STATE_CFG = {
  idle: {
    eye: "pill",
    blink: 4.2,
    wave: "breathe",
    pose: P(),
    lean: 0,
    drift: { x: 0.018, y: 0.014, speed: 0.22 },
    props: [],
    fx: [
      { type: "orbit", when: "behind", n: 3, r0: 0.4, r1: 0.5, speed: 0.22, size: 0.014, alpha: 0.42 },
      { type: "orbit", when: "front", n: 2, r0: 0.4, r1: 0.46, speed: -0.16, size: 0.011, alpha: 0.5 }
    ]
  },
  queued: {
    eye: "pill",
    blink: 4.6,
    wave: "sway",
    pose: P({ rot: 0.02, eX: -0.012 }),
    lean: 0,
    drift: { x: 0.03, y: 0.012, speed: 0.3 },
    props: [{ type: "hourglass" }],
    fx: [
      { type: "orbit", when: "behind", n: 4, r0: 0.4, r1: 0.52, speed: 0.3, size: 0.013, alpha: 0.4 },
      { type: "corners", when: "front", r: 0.44, speed: 0.8, alpha: 0.45 }
    ]
  },
  boot: {
    eye: "pill",
    blink: 3.4,
    wave: "float",
    pose: P({ sx: 0.94, sy: 0.94 }),
    lean: 0,
    props: [{ type: "bar" }],
    fx: [
      { type: "corners", when: "behind", r: 0.44, speed: 1.5, alpha: 0.6 },
      { type: "orbit", when: "front", n: 3, r0: 0.38, r1: 0.46, speed: 0.7, size: 0.012, alpha: 0.5 }
    ]
  },
  load: {
    eye: "wake",
    blink: 0,
    wave: "float",
    pose: P(),
    lean: 0,
    props: [{ type: "bar" }],
    fx: [
      { type: "corners", when: "front", r: 0.46, speed: 0.5, alpha: 0.35 },
      { type: "orbit", when: "behind", n: 3, r0: 0.4, r1: 0.5, speed: 0.35, size: 0.012, alpha: 0.35 }
    ]
  },
  stop: {
    eye: "sleep",
    blink: 0,
    wave: null,
    pose: P({ sy: 0.93, y: 0.02 }),
    lean: 0,
    props: [{ type: "stopBox" }],
    fx: [{ type: "orbit", when: "behind", n: 2, r0: 0.42, r1: 0.5, speed: 0.06, size: 0.01, alpha: 0.18 }]
  },
  think: {
    eye: "pill",
    blink: 3.6,
    wave: "float",
    pose: P({ eY: -0.018 }),
    lean: 0,
    drift: { x: 0.034, y: 0.04, speed: 0.55 },
    props: [],
    fx: [
      { type: "thoughts", when: "behind", n: 3, r0: 0.42, r1: 0.56, speed: 0.55, size: 0.018, alpha: 0.65 },
      { type: "glyphs", when: "front", chars: ["·", "•"], n: 4, r0: 0.4, r1: 0.5, size: 0.04, alpha: 0.5 }
    ]
  },
  plan: {
    eye: "pill",
    blink: 0,
    wave: "nod",
    pose: P({ eY: 0.01, eX: 0.03 }),
    lean: 0.018,
    drift: { x: 0.05, y: 0.035, speed: 0.7 },
    props: [{ type: "checklist", mode: "fill", rows: 3 }],
    fx: [{ type: "corners", when: "behind", r: 0.46, speed: 0.4, alpha: 0.28 }]
  },
  compact: {
    eye: "narrow",
    blink: 4.4,
    wave: "compact",
    pose: P({ eW: 0.155, eH: 0.26 }),
    lean: 0,
    props: [{ type: "stack" }],
    fx: [
      { type: "edges", when: "front", r0: 0.46, r1: 0.37, speed: 1.2, alpha: 0.55 },
      { type: "orbit", when: "behind", n: 2, r0: 0.42, r1: 0.5, speed: -0.4, size: 0.012, alpha: 0.3 }
    ]
  },
  type: {
    eye: "narrow",
    blink: 0,
    wave: "type",
    pose: P({ eW: 0.155, eH: 0.26, eY: 0.045 }),
    lean: 0,
    drift: { x: 0.006, y: 0.008, speed: 3.4 },
    props: [{ type: "keys", w: 0.36, y: 0.33, n: 6 }],
    fx: [{ type: "orbit", when: "behind", n: 3, r0: 0.42, r1: 0.5, speed: 0.2, size: 0.008, alpha: 0.25 }]
  },
  read: {
    eye: "pill",
    blink: 0,
    wave: "read",
    pose: P({ eX: 0.028, eY: 0.006 }),
    lean: 0.02,
    drift: { x: 0.008, y: 0.05, speed: 0.55 },
    props: [{ type: "page", h: 0.2, mode: "read" }],
    fx: [{ type: "orbit", when: "behind", n: 2, r0: 0.44, r1: 0.5, speed: 0.15, size: 0.01, alpha: 0.25 }]
  },
  find: {
    eye: "squint",
    blink: 0,
    wave: "ping",
    pose: P({ eW: 0.17, eH: 0.2, eX: 0.02 }),
    lean: 0.012,
    drift: { x: 0.05, y: 0.04, speed: 1.1 },
    props: [{ type: "lens" }],
    fx: [
      { type: "grid", when: "front", n: 5, speed: 0.45, alpha: 0.55 },
      { type: "orbit", when: "behind", n: 2, r0: 0.44, r1: 0.52, speed: 0.2, size: 0.01, alpha: 0.25 }
    ]
  },
  web: {
    eye: "squint",
    blink: 0,
    wave: "ping",
    pose: P({ eW: 0.17, eH: 0.2, eY: 0.025 }),
    lean: 0,
    props: [{ type: "browser" }],
    fx: [{ type: "orbit", when: "behind", n: 5, r0: 0.4, r1: 0.54, speed: 0.65, size: 0.013, alpha: 0.5 }]
  },
  check: {
    eye: "squint",
    blink: 3.2,
    wave: "pulse",
    pose: P({ eW: 0.17, eH: 0.2, eX: 0.022 }),
    lean: 0.018,
    props: [{ type: "page", h: 0.2, mode: "check" }],
    fx: [{ type: "aura", when: "behind", alpha: 0.2 }]
  },
  warn: {
    eye: "squint",
    blink: 4,
    wave: "sway",
    pose: P({ eW: 0.17, eH: 0.2, eX: 0.015 }),
    lean: 0.006,
    props: [{ type: "badge", ch: "!", x: 0.35, y: -0.16, size: 0.11 }],
    fx: [{ type: "aura", when: "behind", alpha: 0.26 }]
  },
  recheck: {
    eye: "pill",
    blink: 3,
    wave: "breathe",
    pose: P({ eW: 0.14, eH: 0.3 }),
    lean: 0,
    props: [{ type: "badge", ch: "↺", x: 0.35, y: -0.15, size: 0.1 }],
    fx: [{ type: "corners", when: "behind", r: 0.46, speed: 0.4, alpha: 0.25 }]
  },
  verify: {
    eye: "squint",
    blink: 4,
    wave: "nod",
    pose: P({ eW: 0.17, eH: 0.2, eX: 0.03 }),
    lean: 0.02,
    drift: { x: 0.03, y: 0.008, speed: 0.35 },
    props: [{ type: "checklist", mode: "scan", rows: 3 }],
    fx: [{ type: "corners", when: "behind", r: 0.46, speed: 0.3, alpha: 0.2 }]
  },
  edit: {
    eye: "narrow",
    blink: 3.4,
    wave: "edit",
    pose: P({ eW: 0.155, eH: 0.28, eX: 0.025 }),
    lean: 0.02,
    drift: { x: 0.016, y: 0.01, speed: 1.7 },
    props: [{ type: "page", h: 0.2, mode: "edit" }],
    fx: [{ type: "orbit", when: "behind", n: 3, r0: 0.42, r1: 0.5, speed: 0.5, size: 0.009, alpha: 0.3 }]
  },
  create: {
    eye: "pill",
    blink: 0,
    wave: "nod",
    pose: P({ eY: 0.012 }),
    lean: 0.008,
    props: [{ type: "pencil" }],
    fx: [{ type: "glyphs", when: "front", chars: ["✦"], n: 1, r0: 0.47, r1: 0.47, size: 0.05, alpha: 0.9, pulse: true }]
  },
  run: {
    eye: "pill",
    blink: 2.2,
    wave: "hop",
    pose: P(),
    lean: 0,
    props: [],
    fx: [
      { type: "speed", when: "behind", n: 7, r0: 0.4, r1: 0.62, speed: 1.6, alpha: 0.45 },
      { type: "dust", when: "front", n: 4, alpha: 0.35 }
    ]
  },
  tests: {
    eye: "pill",
    blink: 1.4,
    wave: "pulse",
    pose: P({ eY: -0.006 }),
    lean: 0.006,
    props: [{ type: "checklist", mode: "alt", rows: 3 }],
    fx: [{ type: "aura", when: "behind", alpha: 0.18 }]
  },
  ask: {
    eye: "wide",
    blink: 5.4,
    wave: "tilt",
    pose: P({ eW: 0.14, eH: 0.44, rot: -0.02, eX: 0.012 }),
    lean: -0.004,
    props: [{ type: "bubble", ch: "?" }],
    fx: [{ type: "orbit", when: "behind", n: 2, r0: 0.44, r1: 0.5, speed: 0.2, size: 0.01, alpha: 0.25 }]
  },
  done: {
    eye: "happy",
    blink: 0,
    wave: "hop",
    pose: P({ eW: 0.2, eH: 0.14 }),
    lean: 0,
    props: [{ type: "check" }],
    fx: [
      { type: "sparks", when: "front", n: 9, alpha: 0.95, burst: true },
      { type: "aura", when: "behind", alpha: 0.24 }
    ]
  },
  update: {
    eye: "happy",
    blink: 0,
    wave: "float",
    pose: P({ eW: 0.2, eH: 0.14 }),
    lean: 0,
    props: [{ type: "arrowUp" }],
    fx: [{ type: "sparks", when: "front", n: 7, alpha: 0.9, burst: true, rise: true }]
  },
  error: {
    eye: "sad",
    blink: 0,
    wave: "sag",
    pose: P({ eW: 0.14, eH: 0.3, sy: 0.96, y: 0.02, tilt: 0.18, eY: 0.02 }),
    lean: 0,
    props: [{ type: "crack" }],
    fx: [
      { type: "embers", when: "front", n: 7, alpha: 0.8 },
      { type: "aura", when: "behind", alpha: 0.28 }
    ]
  }
};
function beat(t, period, peak = 0.1) {
  const k = t % period / period;
  if (k < peak)
    return k / peak;
  return Math.max(0, 1 - (k - peak) / 0.55);
}
function bodyDynamics(kind, t) {
  const o = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
  if (!kind)
    return o;
  let b = 0;
  switch (kind) {
    case "hop":
      b = beat(t, 1.5, 0.1);
      o.dy = -0.12 * b;
      o.sy = 1 + 0.09 * b;
      o.sx = 1 - 0.06 * b;
      o.dx = 0.01 * b;
      o.rot = -0.03 * b;
      break;
    case "nod":
      b = beat(t, 3, 0.16);
      o.dy = -0.03 * b;
      o.sy = 1 - 0.022 * b;
      o.rot = 0.015 * b;
      break;
    case "sag":
      o.dy = 0.016 + Math.sin(t * 1.4) * 0.008;
      o.sy = 1 - 0.03 - Math.sin(t * 1.4) * 0.006;
      o.rot = Math.sin(t * 0.7) * 0.015;
      break;
    case "tilt":
      o.rot = Math.sin(t * 2.4) * 0.06;
      o.dx = Math.sin(t * 2.4) * 0.012;
      break;
    case "sway":
      o.rot = Math.sin(t * 1.45) * 0.04;
      o.dx = Math.sin(t * 1.45) * 0.01;
      break;
    case "float":
      o.dy = Math.sin(t * 1.15) * 0.028;
      o.sy = 1 + Math.sin(t * 1.15) * 0.01;
      o.rot = Math.sin(t * 0.9) * 0.015;
      break;
    case "type":
      b = Math.pow(Math.max(0, Math.sin(t * 6.4)), 8);
      o.dy = -0.022 * b;
      o.sy = 1 - 0.045 * b;
      o.sx = 1 + 0.03 * b;
      o.rot = 0.02 * b;
      break;
    case "ping":
      b = beat(t, 2.6, 0.18);
      o.dy = -0.01 * b;
      o.sx = 1 + 0.03 * b;
      o.sy = 1 + 0.03 * b;
      break;
    case "pulse":
      b = beat(t, 0.9, 0.12);
      o.dy = -0.012 * b;
      o.sx = 1 + 0.03 * b;
      o.sy = 1 - 0.02 * b;
      break;
    case "compact":
      b = beat(t, 2.4, 0.08);
      o.sx = 1 - 0.32 * b;
      o.sy = 1 + 0.06 * b;
      break;
    case "breathe":
      o.sy = 1 + Math.sin(t * 1.1) * 0.012;
      o.dy = Math.sin(t * 1.1) * 0.006;
      break;
    case "read":
      b = beat(t, 2.2, 0.35);
      o.dy = -0.02 * b;
      o.rot = 0.02 * b;
      o.sy = 1 - 0.015 * b;
      break;
    case "edit":
      o.rot = 0.012 + Math.sin(t * 2.7) * 0.018;
      o.dy = -0.012 * Math.pow(Math.max(0, Math.sin(t * 2.7)), 4);
      break;
  }
  return o;
}
function blinkFactor(t, period, phase) {
  if (!period)
    return 1;
  const k = (t + phase) % period;
  const d = 0.14;
  if (k > period - d) {
    const x = (k - (period - d)) / d;
    return 1 - Math.sin(x * Math.PI) * 0.94;
  }
  return 1;
}

// src/modules/webui/assets/js/mascot-util.ts
var TAU = Math.PI * 2;
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smooth(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
function easeOut(t) {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}
function seedAt(seed, i) {
  let x = seed * 4294967296 + i * 2654435761 >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519);
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}
function hexRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3)
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbHex(rgb) {
  return "#" + rgb.map((v) => {
    const s = Math.round(clamp(v, 0, 255)).toString(16);
    return s.length === 1 ? "0" + s : s;
  }).join("");
}
function lum(hex) {
  const c = hexRgb(hex).map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function ensureContrast(color, bg, min) {
  if (contrast(color, bg) >= min)
    return color;
  const towardLight = lum(bg) < 0.45;
  let rgb = hexRgb(color);
  for (let i = 0;i < 60; i++) {
    if (contrast(rgbHex(rgb), bg) >= min)
      break;
    rgb = rgb.map((v) => towardLight ? v + (255 - v) * 0.06 : v * 0.94);
  }
  return rgbHex(rgb);
}
function mixHex(a, b, t) {
  const A = hexRgb(a);
  const B = hexRgb(b);
  return rgbHex([lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)]);
}
function rgba(hex, a) {
  const c = hexRgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function dot(ctx, x, y, r, color, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.6, r), 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// src/modules/webui/assets/js/mascot-fx.ts
var FX = {
  orbit(g, c) {
    const n = c.n ?? 3;
    for (let i = 0;i < n; i++) {
      const s = seedAt(g.seed, i);
      const a = g.t * (c.speed ?? 0.3) * (i % 2 ? -1 : 1) + i * TAU / n + s * TAU;
      const r = g.u * lerp(c.r0 ?? 0.4, c.r1 ?? 0.5, seedAt(g.seed, i + 31));
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r * 0.92;
      const al = (c.alpha ?? 0.4) * (0.55 + 0.45 * Math.sin(g.t * 2.1 + i * 1.7));
      dot(g.ctx, x, y, g.u * (c.size ?? 0.012) * (0.7 + 0.6 * s), g.accent, clamp(al, 0, 1));
    }
  },
  thoughts(g, c) {
    const n = c.n ?? 3;
    for (let i = 0;i < n; i++) {
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
    for (let iy = 0;iy < n; iy++) {
      for (let ix = 0;ix < n; ix++) {
        const x = (ix + 0.5) / n * g.w;
        const y = (iy + 0.5) / n * g.h;
        if (Math.hypot(x - g.cx, y - g.cy) < g.u * 0.3)
          continue;
        const wave = Math.cos(x / g.w * Math.PI * 3 - g.t * (c.speed ?? 0.45) * 3);
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
    for (let i = 0;i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2;
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
    for (let side = -1;side <= 1; side += 2) {
      const x = g.cx + side * g.u * (c.x ?? 0.36);
      const k = (g.t * (c.speed ?? 0.3) + (side > 0 ? 0.5 : 0)) % 1;
      const y = g.cy - g.u * 0.22 + k * g.u * 0.44;
      ctx.globalAlpha = (c.alpha ?? 0.5) * (0.35 + 0.65 * Math.sin(Math.PI * k));
      ctx.fillStyle = rgba(g.colors.accent, 1);
      const h = g.u * 0.13;
      ctx.beginPath();
      ctx.roundRect(x - g.u * (c.size ?? 0.018) / 2, y - h / 2, g.u * (c.size ?? 0.018), h, g.u * 0.01);
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
    for (let i = 0;i < n; i++) {
      const a = -Math.PI / 2 + i / n * TAU + (n === 1 ? 0.5 : 0);
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
    const k = g.t * (c.speed ?? 1) % 1;
    const pos = g.u * lerp(c.r0 ?? 0.46, c.r1 ?? 0.37, k);
    const len = g.u * 0.18;
    ctx.save();
    ctx.strokeStyle = rgba(g.colors.accent, 1);
    ctx.lineWidth = Math.max(1.5, g.u * 0.012);
    ctx.lineCap = "round";
    for (let side = -1;side <= 1; side += 2) {
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
    for (let i = 0;i < n; i++) {
      const a = i / n * TAU + seedAt(g.seed, i) * 0.5;
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
    const b = Math.max(0, 1 - (g.t % 1.5 / 1.5 - 0.1) / 0.55);
    for (let i = 0;i < n; i++) {
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
    for (let i = 0;i < n; i++) {
      const s = seedAt(g.seed, i + 17);
      const a = i / n * TAU + s * 0.7;
      const dist = g.u * (0.36 + (1 - burst) * (0.14 + s * 0.14));
      const y = g.cy + Math.sin(a) * dist * 0.9 - (c.rise ? (1 - burst) * g.u * 0.12 : 0) + (c.rise ? 0 : Math.sin(g.t * 1.4 + i) * g.u * 0.006);
      const x = g.cx + Math.cos(a) * dist;
      const tw = 0.5 + 0.5 * Math.sin(g.t * 3 + i * 2.1);
      dot(ctx, x, y, g.u * (0.008 + s * 0.008), g.accent, (c.alpha ?? 0.9) * burst * (0.6 + 0.4 * tw));
    }
    ctx.restore();
  },
  embers(g, c) {
    const n = c.n ?? 6;
    for (let i = 0;i < n; i++) {
      const s = seedAt(g.seed, i + 23);
      const k = (g.t * 0.28 + i / n + s * 0.2) % 1;
      const a = -Math.PI / 2 + (s - 0.5) * 2.2 + Math.sin(g.t * 0.8 + i) * 0.12;
      const r = g.u * (0.38 + (1 - k) * 0.18);
      const x = g.cx + Math.cos(a) * r;
      const y = g.cy + Math.sin(a) * r + k * g.u * 0.16;
      dot(g.ctx, x, y, g.u * (0.007 + s * 0.006), g.accent, (c.alpha ?? 0.8) * (1 - k) * 0.9);
    }
  }
};
function drawFx(name, g, c) {
  const fn = FX[name];
  if (fn)
    fn(g, c);
}

// src/modules/webui/assets/js/mascot-prop-util.ts
function panel(ctx, x, y, w, h, r, fill, stroke) {
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
function check(ctx, cx, cy, s, color, alpha) {
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
function cross(ctx, cx, cy, s, color, alpha) {
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

// src/modules/webui/assets/js/mascot-props-work.ts
var PROPS_WORK = {
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
    for (let i = 0;i < n; i++) {
      const tap = Math.pow(Math.max(0, Math.sin(g.t * 6.4 + i * 1.1)), 10);
      const x = x0 + gap + i * (kw + gap);
      panel(ctx, x, y0 - h * 0.34 - tap * h * 0.22, kw, h * 0.68, h * 0.24, rgba(g.colors.accent, 0.35 + tap * 0.55), null);
    }
  },
  check(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.115;
    const x = g.cx + u * 0.35;
    const y = g.cy - u * 0.15;
    const k = clamp(g.t % 3.4 / 0.6, 0, 1);
    const p1 = [x - s * 0.5, y];
    const p2 = [x - s * 0.08, y + s * 0.4];
    const p3 = [x + s * 0.62, y - s * 0.55];
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
    if (b > 0)
      ctx.lineTo(lerp(p2[0], p3[0], b), lerp(p2[1], p3[1], b));
    ctx.stroke();
    ctx.restore();
  },
  arrowUp(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.115;
    const x = g.cx + u * 0.35;
    const y = g.cy - u * 0.14 + Math.sin(g.t * 1.2) * u * 0.008;
    const k = clamp(g.t % 3 / 0.55, 0, 1);
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
    for (let i = 1;i <= 7; i++) {
      ctx.lineTo(x0 + w * i / 7, y + (i % 2 ? -1 : 1) * u * 0.02);
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
    const k = g.t * 0.45 % 1;
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
    const k = g.t * 0.45 % 1;
    ctx.fillStyle = rgba(g.accent, 0.9);
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(h, w * k), h, h / 2);
    ctx.fill();
  },
  pencil(g, c) {
    const ctx = g.ctx;
    const u = g.u;
    const s = u * 0.1;
    const k = g.t * 0.55 % 1;
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
    const k = g.t * 0.85 % 1;
    for (let i = 0;i < 3; i++) {
      const off = (i - 1) * (1 - k) * u * 0.05;
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = rgba(g.colors.accent, 1);
      ctx.fillRect(x, g.cy + off - u * 0.005, w, Math.max(1, u * 0.009));
    }
    ctx.globalAlpha = 1;
  }
};

// src/modules/webui/assets/js/mascot-props.ts
var PROPS = {
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
    for (let i = 0;i < 4; i++) {
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = rgba(g.colors.accent, 1);
      ctx.fillRect(x + pad, y + h * 0.17 + i * (lh + gap), w - pad * 2 - (i === 3 ? w * 0.3 : 0), lh);
    }
    ctx.globalAlpha = 1;
    if (c.mode === "read" || c.mode === "scan") {
      const k = g.t * 0.55 % 1;
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
    if (c.mode === "check")
      check(ctx, x + w * 0.6, y + h * 0.82, w * 0.6, g.accent, 0.95);
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
    for (let i = 0;i < rows; i++) {
      const by = y + h * 0.12 + i * rowH;
      const bs = w * 0.2;
      const bx = x + w * 0.1;
      panel(ctx, bx, by, bs, bs, bs * 0.18, null, rgba(g.colors.accent, 0.4));
      const phase = g.t * 0.9 - i * 0.7;
      const pass = c.mode === "alt" ? Math.sin(g.t * 2.2 - i * 1.4) > 0 : Math.sin(phase) > -0.2;
      if (c.mode === "alt") {
        if (Math.sin(g.t * 2.2 - i * 1.4) > 0)
          check(ctx, bx + bs / 2, by + bs / 2, bs * 1.05, g.accent, 0.95);
        else
          cross(ctx, bx + bs / 2, by + bs / 2, bs * 0.95, g.colors.accent, 0.85);
      } else if (pass || c.mode === "scan") {
        check(ctx, bx + bs / 2, by + bs / 2, bs * 1.05, g.accent, 0.95);
      }
      ctx.fillStyle = rgba(g.colors.accent, 0.45);
      ctx.fillRect(bx + bs * 1.7, by + bs * 0.36, w * 0.5, Math.max(1, u * 0.006));
    }
    if (c.mode === "scan") {
      const k = g.t * 0.5 % 1;
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
    for (let i = 0;i < 3; i++)
      ctx.fillRect(x + w * 0.04 + i * w * 0.05, y + h * 0.16, w * 0.025, h * 0.12);
    ctx.fillStyle = rgba(g.colors.accent, 0.28);
    ctx.fillRect(x + w * 0.24, y + h * 0.14, w * 0.52, h * 0.16);
    const k = g.t * 0.4 % 1;
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
    const cs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
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
  }
};
function drawProp(name, g, c) {
  const fn = PROPS[name];
  if (fn)
    fn(g, c);
}

// src/modules/webui/assets/js/mascot-draw.ts
var BODY = 0.5;
function rounded(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
function eye(ctx, shape, x, y, w, h, blink, tilt, color) {
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
  if (tilt)
    ctx.rotate(tilt);
  rounded(ctx, -w / 2, -hh / 2, w, Math.max(2, hh), w / 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
function blend(a, b, t) {
  return {
    face: mixHex(a.face, b.face, t),
    eye: mixHex(a.eye, b.eye, t),
    edge: mixHex(a.edge, b.edge, t),
    accent: mixHex(a.accent, b.accent, t),
    isLight: b.isLight
  };
}
function renderFace(s) {
  const { ctx, w, h, dpr } = s;
  if (!w || !h)
    return;
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
    ctx,
    cx,
    cy,
    u,
    w,
    h,
    t: s.time,
    entry: s.entry,
    seed: s.seed,
    accent: col.accent,
    colors: col
  };
  const paint = (stateKey, seed, colors, fade, behind) => {
    const layer = s.layer;
    if (!layer)
      return;
    const lctx = layer.getContext("2d");
    if (!lctx)
      return;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    const g = {
      ctx: lctx,
      cx,
      cy,
      u,
      w,
      h,
      t: s.time,
      entry: s.entry,
      seed,
      accent: colors.accent,
      colors
    };
    const stateCfg = stateKey === s.state ? cfg : prev;
    if (behind) {
      if (!showFx)
        return;
      for (const fx of stateCfg.fx) {
        if (fx.when !== "front")
          drawFx(fx.type, g, fx);
      }
    } else {
      if (showProps)
        for (const prop of stateCfg.props)
          drawProp(prop.type, g, prop);
      if (showFx)
        for (const fx of stateCfg.fx) {
          if (fx.when === "front")
            drawFx(fx.type, g, fx);
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
        if (fx.when !== "front")
          drawFx(fx.type, env, fx);
      }
    } else {
      const layer = s.layer;
      if (layer) {
        paint(s.prevState, s.prevSeed, s.prevColors, 1 - m, true);
        if (m > 0)
          paint(s.state, s.seed, s.colors, m, true);
      }
    }
  }
  const dCur = bodyDynamics(cfg.wave, s.time);
  const dPrev = m < 1 ? bodyDynamics(prev.wave, s.time) : dCur;
  const dyn = m < 1 ? {
    dx: lerp(dPrev.dx, dCur.dx, m),
    dy: lerp(dPrev.dy, dCur.dy, m),
    sx: lerp(dPrev.sx, dCur.sx, m),
    sy: lerp(dPrev.sy, dCur.sy, m),
    rot: lerp(dPrev.rot, dCur.rot, m)
  } : dCur;
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
  if (!showFx)
    return;
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
    if (showProps)
      for (const prop of cfg.props)
        drawProp(prop.type, env, prop);
    ctx.globalAlpha = 1;
    for (const fx of cfg.fx) {
      if (fx.when === "front")
        drawFx(fx.type, env, fx);
    }
  } else {
    paint(s.prevState, s.prevSeed, s.prevColors, 1 - m, false);
    if (m > 0)
      paint(s.state, s.seed, s.colors, m, false);
  }
  ctx.restore();
}

// src/modules/webui/assets/js/mascot-palette.ts
var FALLBACK = {
  "--surface": "#1f1f1f",
  "--panel": "#191919",
  "--dim-a": "#a3a3a3",
  "--accent": "#c4a8ec",
  "--accent-bg": "#241e30",
  "--recon": "#38bdf8",
  "--mutate": "#e879c8",
  "--exec": "#6ea8fe",
  "--green": "#c9c5bd",
  "--yellow": "#d9a45b",
  "--red": "#e08080"
};
var EYE = {
  "c-active": ["#241e30", "#241e30"],
  "c-recon": ["#08222f", "#eaf6ff"],
  "c-mutate": ["#2e0b24", "#fff0fa"],
  "c-exec": ["#0a1730", "#eaf1ff"],
  "c-ok": ["#04221a", "#eafff6"],
  "c-warn": ["#2a1e05", "#fff8e6"],
  "c-err": ["#2a0d0d", "#ffecec"]
};
var BG = {
  "c-active": "--accent",
  "c-recon": "--recon",
  "c-mutate": "--mutate",
  "c-exec": "--exec",
  "c-ok": "--green",
  "c-warn": "--yellow",
  "c-err": "--red"
};
function catOf(state) {
  return FACE_CLASS[state].split(" ")[0];
}
function catOfElement(el, state) {
  if (el) {
    for (const cls of el.classList) {
      if (cls.startsWith("c-"))
        return cls;
    }
  }
  return catOf(state);
}
function palette(el, cat) {
  const win = el.ownerDocument.defaultView;
  const cs = win ? win.getComputedStyle(el) : null;
  const doc = el.ownerDocument;
  const isLight = !!doc.documentElement?.classList.contains("light") || !!doc.body?.classList.contains("light");
  const get = (name) => (cs ? cs.getPropertyValue(name).trim() : "") || FALLBACK[name] || "#888888";
  const panel2 = get("--panel");
  const face = cat === "c-dim" ? get("--surface") : get(BG[cat] || "--accent");
  const eyePref = cat === "c-dim" ? get("--dim-a") : isLight ? EYE[cat][1] : EYE[cat][0];
  const eye2 = ensureContrast(eyePref, face, 4.5);
  const faceAdj = cat === "c-dim" ? face : ensureContrast(face, panel2, 3);
  return {
    face: faceAdj,
    eye: eye2,
    edge: cat === "c-dim" ? get("--border-2") : mixHex(faceAdj, isLight ? "#000000" : "#ffffff", 0.22),
    accent: cat === "c-dim" ? get("--dim-a") : get(BG[cat] || "--accent"),
    isLight
  };
}
function radiusFraction(el) {
  const win = el.ownerDocument.defaultView;
  const host = el.parentElement;
  if (!win || !host)
    return 0.32;
  const cs = win.getComputedStyle(host);
  const raw = cs.borderTopLeftRadius;
  const rect = host.getBoundingClientRect();
  const faceSize = Math.min(rect.width, rect.height);
  if (!faceSize)
    return 0.32;
  const n = parseFloat(raw) || 0;
  const px = raw.trim().endsWith("%") ? n / 100 * faceSize : n;
  return Math.max(0, Math.min(0.5, px / faceSize));
}

// src/modules/webui/assets/js/mascot-canvas.ts
var K = 190;
var C = 20;
var instances = new Set;
var themeVersion = 0;
var reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;

class Mascot {
  canvas;
  handle;
  ctx;
  track = false;
  state;
  prevState;
  cfg;
  prevCfg;
  colors;
  prevColors;
  paletteVersion = -1;
  pose;
  vel = {};
  time = 0;
  entry = 0;
  mix = 1;
  pulse = 0;
  seed;
  prevSeed;
  w = 0;
  h = 0;
  dpr = 1;
  radius = 0.32;
  visible = true;
  trackX = 0;
  trackY = 0;
  targetX = 0;
  targetY = 0;
  blinkOnce = 0;
  layer = null;
  ro = null;
  io = null;
  constructor(canvas, state) {
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
      poke: () => {
        this.blinkOnce = 0.14;
        if (reduced)
          this.draw();
      },
      destroy: () => this.destroy()
    };
    this.bindSize();
  }
  bindSize() {
    const apply = () => {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(8, Math.round(rect.width));
      const h = Math.max(8, Math.round(rect.height));
      const dpr = Math.min(2, typeof window !== "undefined" && window.devicePixelRatio || 1);
      if (w === this.w && h === this.h && dpr === this.dpr)
        return;
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
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(apply);
    if (typeof window !== "undefined") {
      window.setTimeout(apply, 80);
      window.setTimeout(apply, 400);
    }
    if (typeof IntersectionObserver === "function") {
      this.io = new IntersectionObserver((rows) => {
        for (const row of rows)
          this.visible = row.isIntersecting;
      }, { rootMargin: "100px" });
      this.io.observe(this.canvas);
    }
  }
  setState(state) {
    if (state === this.state)
      return;
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
      for (const k in this.vel)
        this.vel[k] = 0;
    }
    this.draw();
  }
  lookAt(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height)
      return;
    const dx = x - (rect.left + rect.width / 2);
    const dy = y - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, dist / 140);
    this.targetX = dx / dist * reach;
    this.targetY = dy / dist * reach;
  }
  advance(dt) {
    this.time += dt;
    this.entry += dt;
    if (this.mix < 1)
      this.mix = Math.min(1, this.mix + dt / 0.36);
    if (this.pulse > 0)
      this.pulse = Math.max(0, this.pulse - dt / 0.42);
    if (this.blinkOnce > 0)
      this.blinkOnce = Math.max(0, this.blinkOnce - dt);
    this.trackX += (this.targetX - this.trackX) * Math.min(1, dt * 10);
    this.trackY += (this.targetY - this.trackY) * Math.min(1, dt * 10);
    const target = this.cfg.pose;
    for (const key in target) {
      const k = key;
      if (this.pose[k] === undefined)
        this.pose[k] = target[k];
      if (this.vel[k] === undefined)
        this.vel[k] = 0;
      const a = (target[k] - this.pose[k]) * K - this.vel[k] * C;
      this.vel[k] += a * dt;
      this.pose[k] += this.vel[k] * dt;
    }
  }
  draw() {
    if (!this.ctx)
      return;
    if (themeVersion !== this.paletteVersion) {
      this.colors = palette(this.canvas, catOfElement(this.canvas.parentElement, this.state));
      this.prevColors = palette(this.canvas, catOfElement(this.canvas.parentElement, this.prevState));
      this.radius = radiusFraction(this.canvas);
      this.paletteVersion = themeVersion;
    }
    if (this.mix < 1 && !this.layer)
      this.layer = document.createElement("canvas");
    if (this.layer && (this.layer.width !== this.canvas.width || this.layer.height !== this.canvas.height)) {
      this.layer.width = this.canvas.width;
      this.layer.height = this.canvas.height;
    }
    renderFace({
      ctx: this.ctx,
      layer: this.mix < 1 ? this.layer : null,
      w: this.w,
      h: this.h,
      dpr: this.dpr,
      cfg: this.cfg,
      prevCfg: this.prevCfg,
      colors: this.colors,
      prevColors: this.prevColors,
      state: this.state,
      prevState: this.prevState,
      pose: this.pose,
      time: reduced ? 0.9 : this.time,
      entry: this.entry,
      seed: this.seed,
      prevSeed: this.prevSeed,
      mix: reduced ? 1 : this.mix,
      pulse: this.pulse,
      trackX: this.trackX,
      trackY: this.trackY,
      blinkOnce: this.blinkOnce,
      radius: this.radius
    });
  }
  destroy() {
    instances.delete(this);
    this.ro?.disconnect();
    this.io?.disconnect();
    this.layer = null;
  }
}
var raf = 0;
var last = 0;
var frames = 0;
function loop(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;
  if (++frames % 120 === 0) {
    for (const m of instances)
      if (!m.canvas.isConnected)
        m.destroy();
  }
  for (const m of instances) {
    if (!m.visible)
      continue;
    m.advance(dt);
    m.draw();
  }
  raf = requestAnimationFrame(loop);
}
function start() {
  if (raf || reduced || typeof requestAnimationFrame !== "function")
    return;
  last = 0;
  raf = requestAnimationFrame(loop);
}
function stop() {
  if (!raf || typeof cancelAnimationFrame !== "function")
    return;
  cancelAnimationFrame(raf);
  raf = 0;
}
function attachMascot(canvas, state) {
  const m = new Mascot(canvas, state);
  if (m.ctx) {
    instances.add(m);
    start();
  }
  return m.handle;
}
function mascotLookAt(x, y) {
  for (const m of instances)
    if (m.track)
      m.lookAt(x, y);
}
function mascotPokeAll() {
  for (const m of instances)
    if (m.track)
      m.handle.poke();
}
if (typeof window !== "undefined") {
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  mq?.addEventListener("change", (e) => {
    reduced = e.matches;
    if (reduced)
      stop();
    else
      start();
    for (const m of instances)
      m.draw();
  });
  if (typeof MutationObserver === "function" && document.body) {
    const bumpTheme = () => {
      themeVersion++;
      for (const m of instances)
        m.draw();
    };
    new MutationObserver(bumpTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    if (document.documentElement && document.documentElement !== document.body) {
      new MutationObserver(bumpTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"]
      });
    }
  }
}

// src/modules/webui/assets/js/mascot-landing.ts
var handles = new WeakMap;
function attach(el, state) {
  const existing = handles.get(el);
  if (existing)
    return existing;
  let canvas = el.querySelector("canvas.mdl-cv");
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
function setState(el, state) {
  attach(el, state).setState(state);
}
function poke(el) {
  handles.get(el)?.poke();
}
window.MMART = { attach, setState, poke, lookAt: mascotLookAt, pokeAll: mascotPokeAll };
