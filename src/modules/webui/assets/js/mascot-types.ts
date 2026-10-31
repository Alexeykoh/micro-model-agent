// Shared types for the canvas mascot. Kept in one small module so the renderer,
// effects and props can reference them without circular imports.

export interface FaceColors {
  face: string;
  eye: string;
  edge: string;
  accent: string;
  isLight: boolean;
}

export interface Pose {
  sx: number;
  sy: number;
  y: number;
  rot: number;
  eX: number;
  eY: number;
  eW: number;
  eH: number;
  spread: number;
  tilt: number;
}

export interface Env {
  ctx: CanvasRenderingContext2D;
  cx: number;
  cy: number;
  u: number;
  w: number;
  h: number;
  t: number;
  entry: number;
  seed: number;
  accent: string;
  colors: FaceColors;
}

export interface FxCfg {
  type: string;
  when?: "front" | "behind";
  n?: number;
  r0?: number;
  r1?: number;
  r?: number;
  speed?: number;
  size?: number;
  alpha?: number;
  x?: number;
  chars?: string[];
  pulse?: boolean;
  rise?: number | boolean;
  burst?: boolean;
}

export interface PropCfg {
  type: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  n?: number;
  size?: number;
  ch?: string;
  mode?: string;
  rows?: number;
}
