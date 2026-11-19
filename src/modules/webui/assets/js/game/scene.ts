// Canvas scene for the MMART mini-game. Everything is pixel art: blocky
// background, sharp pipes and a 4px-grid mascot drawn straight onto the game
// canvas (no DOM canvas overlay — that used to leak a square aura). Colours
// come from the active theme, so the game follows light/dark and accents.
import {
  BIRD_X,
  GAP,
  GROUND,
  H,
  PIPE_W,
  W,
  type Palette,
  type Phase,
  type Pipe,
} from "./world.js";

export interface SceneState {
  birdY: number;
  pipes: Pipe[];
  phase: Phase;
  /** Seconds since the crash; drives the red flash and embers. */
  crashT: number;
  /** Seconds since the game opened; scrolls the pixel sky. */
  time: number;
}

let palette: Palette | null = null;
let stageEl: HTMLElement | null = null;
let canvasEl: HTMLCanvasElement | null = null;

const UNIT = 4;
const COLS = 10;
const ROWS = 9;
const CRASH_LIFE = 1.4;

interface Star {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  bright: boolean;
}

function rnd(n: number): number {
  const v = Math.sin(n * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

const STARS: Star[] = Array.from({ length: 46 }, (_, i) => ({
  x: rnd(i + 1) * W,
  y: rnd(i + 101) * (H - GROUND - 24),
  size: rnd(i + 201) > 0.72 ? 4 : 2,
  speed: 3 + rnd(i + 301) * 9,
  phase: rnd(i + 401) * Math.PI * 2,
  bright: rnd(i + 501) > 0.55,
}));

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

export function readPalette(): Palette {
  const style = getComputedStyle(document.body);
  return {
    bg: cssVar(style, "--bg", "#141414"),
    panel: cssVar(style, "--panel", "#191919"),
    surface: cssVar(style, "--surface", "#1f1f1f"),
    accent: cssVar(style, "--accent", "#c4a8ec"),
    border: cssVar(style, "--border-2", "#2e2e2e"),
    fg: cssVar(style, "--fg", "#e6edf3"),
    dim: cssVar(style, "--dim-a", "#a3a3a3"),
    green: cssVar(style, "--green", "#8bd450"),
    red: cssVar(style, "--red", "#e08080"),
    yellow: cssVar(style, "--yellow", "#d9a45b"),
  };
}

export function setPalette(next: Palette): void {
  palette = next;
}

function bind(stage: HTMLElement): void {
  if (stageEl === stage) return;
  stageEl = stage;
  canvasEl = stage.querySelector<HTMLCanvasElement>(".game-canvas");
}

/** One art pixel: integer-aligned rectangles only, no antialiased paths. */
function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha = 1,
): void {
  if (w <= 0 || h <= 0 || alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  ctx.globalAlpha = 1;
}

function drawSky(ctx: CanvasRenderingContext2D, pal: Palette, time: number): void {
  px(ctx, 0, 0, W, H, pal.bg);
  for (const star of STARS) {
    const x = ((star.x - time * star.speed) % W + W) % W;
    const pulse = Math.sin(time * 2 + star.phase);
    const alpha = pulse > 0 ? 0.85 : 0.3;
    px(ctx, x, star.y, star.size, star.size, star.bright ? pal.fg : pal.dim, alpha);
  }

  // Blocky clouds, slower than the pipes: a cheap parallax layer.
  for (let i = 0; i < 3; i++) {
    const drift = (time * (8 + i * 4) + i * 260) % (W + 180);
    const x = W + 90 - drift;
    const y = 42 + i * 62;
    const cloud = i % 2 === 0 ? pal.panel : pal.surface;
    px(ctx, x, y + 8, 44, 8, cloud, 0.7);
    px(ctx, x + 8, y, 26, 8, cloud, 0.7);
    px(ctx, x + 16, y - 6, 12, 6, cloud, 0.55);
  }
}

function drawPipes(ctx: CanvasRenderingContext2D, pal: Palette, pipes: Pipe[]): void {
  for (const pipe of pipes) {
    const top = Math.round(pipe.gap - GAP / 2);
    const bottom = Math.round(pipe.gap + GAP / 2);
    const x = Math.round(pipe.x);
    for (const [y0, y1] of [[0, top], [bottom, H - GROUND]] as Array<[number, number]>) {
      const h = y1 - y0;
      if (h <= 0) continue;
      px(ctx, x, y0, PIPE_W, h, pal.accent);
      px(ctx, x + 4, y0, 4, h, pal.fg, 0.18);
      px(ctx, x + PIPE_W - 8, y0, 8, h, pal.bg, 0.28);
    }
    // Sharp lips, 6px wider than the shaft; deliberately no rounded corners.
    px(ctx, x - 6, Math.max(0, top - 18), PIPE_W + 12, 18, pal.accent);
    px(ctx, x - 2, Math.max(0, top - 18), 4, 18, pal.fg, 0.18);
    px(ctx, x - 6, bottom, PIPE_W + 12, 18, pal.accent);
    px(ctx, x - 2, bottom, 4, 18, pal.fg, 0.18);
  }
}

function drawGround(ctx: CanvasRenderingContext2D, pal: Palette): void {
  px(ctx, 0, H - GROUND, W, GROUND, pal.surface);
  px(ctx, 0, H - GROUND, W, 2, pal.border);
  for (let x = 0; x < W; x += 16) {
    px(ctx, x, H - GROUND + 8, 8, 6, pal.panel);
    px(ctx, x + 8, H - GROUND + 22, 8, 6, pal.panel);
  }
}

function eyePixels(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  phase: Phase,
  ink: string,
): void {
  if (phase === "over") {
    // X eyes: the error face, block by block.
    for (const [dx, dy] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]) {
      px(ctx, x + dx * UNIT, y + dy * UNIT, UNIT, UNIT, ink);
    }
    return;
  }
  if (phase === "ready") {
    // Happy ∧ eyes.
    px(ctx, x, y + UNIT, UNIT, UNIT, ink);
    px(ctx, x + UNIT, y, UNIT, UNIT, ink);
    px(ctx, x + UNIT * 2, y + UNIT, UNIT, UNIT, ink);
    return;
  }
  px(ctx, x, y, UNIT, UNIT * 2, ink);
  px(ctx, x + UNIT, y, UNIT, UNIT * 2, ink);
}

function drawMascot(ctx: CanvasRenderingContext2D, pal: Palette, state: SceneState): void {
  const left = Math.round(BIRD_X - (COLS * UNIT) / 2);
  const top = Math.round(state.birdY - (ROWS * UNIT) / 2);
  const body = state.phase === "over" ? pal.red : pal.green;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const corner = (row === 0 || row === ROWS - 1) && (col === 0 || col === COLS - 1);
      if (corner) continue;
      px(ctx, left + col * UNIT, top + row * UNIT, UNIT, UNIT, body);
    }
  }
  // Pixel shading: a darker bottom band and a highlight on the top edge.
  px(ctx, left + UNIT, top + (ROWS - 1) * UNIT, (COLS - 2) * UNIT, UNIT, pal.bg, 0.18);
  px(ctx, left + UNIT, top, (COLS - 2) * UNIT, UNIT, pal.fg, 0.16);

  const eyeY = top + 3 * UNIT;
  eyePixels(ctx, left + 2 * UNIT, eyeY, state.phase, pal.bg);
  eyePixels(ctx, left + 6 * UNIT, eyeY, state.phase, pal.bg);

  if (state.phase === "over" && state.crashT < CRASH_LIFE) {
    drawCrash(ctx, pal, state);
  }
}

function drawCrash(ctx: CanvasRenderingContext2D, pal: Palette, state: SceneState): void {
  const t = state.crashT;
  const flash = Math.max(0, 1 - t / 0.3);
  px(ctx, 0, 0, W, H, pal.red, 0.3 * flash);

  const fade = Math.max(0, 1 - t / CRASH_LIFE);
  if (t < 0.5) {
    const ring = 24 + t * 80;
    const alpha = 0.85 * (1 - t / 0.5);
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      px(
        ctx,
        BIRD_X + Math.cos(angle) * ring - UNIT / 2,
        state.birdY + Math.sin(angle) * ring - UNIT / 2,
        UNIT,
        UNIT,
        pal.red,
        alpha,
      );
    }
  }
  for (let i = 0; i < 14; i++) {
    const s = rnd(i + 700);
    const x = BIRD_X + (s - 0.5) * 70 + Math.sin(t * 3 + i) * 6;
    const y = state.birdY - t * 55 - s * 36;
    const size = 2 + Math.round(rnd(i + 800) * 4);
    px(ctx, x, y, size, size, i % 3 === 0 ? pal.yellow : pal.red, fade * (0.45 + 0.55 * rnd(i + 900)));
  }
}

export function drawScene(stage: HTMLElement, state: SceneState): void {
  bind(stage);
  if (!canvasEl) return;
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Integer backing scale: every art pixel lands on whole canvas pixels, so
  // blocks stay crisp instead of smearing across fractional device pixels.
  const scale = Math.max(1, Math.round((rect.width * dpr) / W));
  const cw = W * scale;
  const ch = H * scale;
  if (canvasEl.width !== cw || canvasEl.height !== ch) {
    canvasEl.width = cw;
    canvasEl.height = ch;
  }

  const pal = palette || readPalette();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawSky(ctx, pal, state.time);
  drawPipes(ctx, pal, state.pipes);
  drawGround(ctx, pal);
  drawMascot(ctx, pal, state);
}
