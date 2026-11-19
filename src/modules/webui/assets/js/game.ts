// MMART flight: a tiny Flappy-style break for `mma web`. The bird is a blocky
// pixel mascot drawn on the game canvas; scene colours come from theme tokens
// (`game/scene.ts`) and all copy goes through i18n. Opens as a modal over the
// chat; Space / ↑ flaps, Esc closes. Deliberately small: this is a time-killer.
import { loadBest, saveBest } from "./game/best.js";
import { drawScene, readPalette, setPalette } from "./game/scene.js";
import { buildView, applyViewI18n, paintScore, syncHint, type GameView } from "./game/view.js";
import {
  BIRD_H,
  BIRD_W,
  BIRD_X,
  FALL_MAX,
  FLAP,
  GAP,
  GRAVITY,
  GROUND,
  H,
  PIPE_W,
  SPACING,
  SPEED,
  W,
  type Phase,
  type Pipe,
} from "./game/world.js";

let view: GameView | null = null;
let observer: MutationObserver | null = null;

let phase: Phase = "ready";
let birdY = H / 2;
let vy = 0;
let bob = 0;
let score = 0;
let best = 0;
let newBest = false;
let spawnIn = 0.9;
let pipes: Pipe[] = [];
let raf = 0;
let last = 0;
let time = 0;
let crashT = 0;
let open = false;
let returnFocus: HTMLElement | null = null;

function paint(): void {
  if (view) paintScore(view, score, best);
}

function hint(): void {
  if (view) syncHint(view, phase, newBest);
}

function resetGame(next: Phase): void {
  phase = next;
  birdY = H / 2;
  vy = 0;
  bob = 0;
  score = 0;
  newBest = false;
  spawnIn = 0.9;
  pipes = [];
  crashT = 0;
  paint();
  hint();
}

function start(): void {
  resetGame("playing");
  vy = FLAP;
}

function crash(): void {
  phase = "over";
  crashT = 0;
  newBest = score > best;
  if (newBest) {
    best = score;
    saveBest(best);
  }
  paint();
  hint();
}

function flapOrRestart(): void {
  if (phase === "playing") vy = FLAP;
  else start();
}

function spawn(): void {
  const margin = GAP / 2 + 40;
  const gap = margin + Math.random() * (H - GROUND - margin * 2);
  pipes.push({ x: W + 30, gap, scored: false });
}

function update(dt: number): void {
  if (phase === "ready") {
    bob += dt;
    birdY = H / 2 + Math.sin(bob * 2.6) * 8;
    return;
  }
  if (phase === "over") {
    crashT += dt;
    return;
  }

  vy = Math.min(FALL_MAX, vy + GRAVITY * dt);
  birdY += vy * dt;
  if (birdY < BIRD_H / 2) {
    birdY = BIRD_H / 2;
    vy = 0;
  }
  if (birdY + BIRD_H / 2 >= H - GROUND) {
    birdY = H - GROUND - BIRD_H / 2;
    crash();
    return;
  }

  spawnIn -= dt;
  if (spawnIn <= 0) {
    spawn();
    spawnIn = SPACING / SPEED;
  }

  const left = BIRD_X - BIRD_W / 2;
  const right = BIRD_X + BIRD_W / 2;
  const top = birdY - BIRD_H / 2;
  const bottom = birdY + BIRD_H / 2;
  for (const pipe of pipes) {
    pipe.x -= SPEED * dt;
    if (!pipe.scored && pipe.x + PIPE_W < left) {
      pipe.scored = true;
      score++;
      paint();
    }
    if (pipe.x < right && pipe.x + PIPE_W > left) {
      if (top < pipe.gap - GAP / 2 || bottom > pipe.gap + GAP / 2) {
        crash();
        return;
      }
    }
  }
  pipes = pipes.filter((pipe) => pipe.x + PIPE_W > -20);
}

function frame(now: number): void {
  if (!open || !view) return;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
  last = now;
  time += dt;
  update(dt);
  drawScene(view.stage, { birdY, pipes, phase, crashT, time });
  raf = requestAnimationFrame(frame);
}

function onKey(e: KeyboardEvent): void {
  if (!open || !view) return;
  if (e.key === "Tab") {
    e.preventDefault();
    const close = view.root.querySelector<HTMLElement>(".game-close");
    if (document.activeElement === close) view.stage.focus();
    else close?.focus();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeGame();
    return;
  }
  const key = e.key;
  const flap =
    key === " " || key === "Spacebar" || key === "ArrowUp" || key === "Enter" || key.toLowerCase() === "w";
  if (!flap) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) flapOrRestart();
}

export function openGame(): void {
  if (!view) view = buildView({ onClose: closeGame, onFlap: flapOrRestart });
  applyViewI18n(view);
  if (open) {
    view.stage.focus();
    return;
  }
  best = loadBest();
  resetGame("ready");
  setPalette(readPalette());
  returnFocus = document.activeElement as HTMLElement | null;
  open = true;
  view.root.hidden = false;
  view.root.classList.add("open");
  last = 0;
  time = 0;
  document.addEventListener("keydown", onKey, true);
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  view.stage.focus();
  drawScene(view.stage, { birdY, pipes, phase, crashT, time });
  raf = requestAnimationFrame(frame);
}

export function closeGame(): void {
  if (!open || !view) return;
  open = false;
  cancelAnimationFrame(raf); raf = 0;
  document.removeEventListener("keydown", onKey, true);
  observer?.disconnect(); observer = null;
  view.root.classList.remove("open"); view.root.hidden = true;
  if (returnFocus && returnFocus.focus) returnFocus.focus();
  returnFocus = null;
}
