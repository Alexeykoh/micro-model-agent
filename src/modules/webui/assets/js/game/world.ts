// Shared geometry and tuning for the MMART mini-game. World units are fixed
// (600×400); the canvas scales to its box, so physics stays identical on any
// screen.
export const W = 600;
export const H = 400;
export const GROUND = 46;
export const GRAVITY = 1300;
export const FLAP = -420;
export const FALL_MAX = 700;
export const SPEED = 165;
export const PIPE_W = 64;
export const GAP = 152;
export const SPACING = 270;
export const BIRD_X = 112;
export const BIRD_W = 34;
export const BIRD_H = 30;
export const BIRD_CANVAS = 76;

export type Phase = "ready" | "playing" | "over";

export interface Pipe {
  x: number;
  gap: number;
  scored: boolean;
}

export interface Palette {
  bg: string;
  panel: string;
  surface: string;
  accent: string;
  border: string;
  fg: string;
  dim: string;
  green: string;
  red: string;
  yellow: string;
}
