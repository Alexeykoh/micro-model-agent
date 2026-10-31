// Live generation speed for the composer rail (tok/s). The number is always an
// estimate from streamed characters: exact per-call usage arrives only when the
// call ends, and the final per-turn number lives in the `llmSpeed` snapshot
// (chip above the input). Per-session: background tabs must not feed the active
// tab's rail.
import { t } from "./i18n.js";

/** Rolling window for the live estimate. */
export const SPEED_WINDOW_MS = 1500;
/** A gap this long means the model stopped writing: drop the window. */
export const SPEED_PAUSE_MS = 1500;
/** Fallback token estimate when the provider does not report usage. */
const CHARS_PER_TOKEN = 4;

interface Sample {
  at: number;
  chars: number;
}
interface TurnSpeed {
  samples: Sample[];
  lastAt: number;
}

export interface SpeedView {
  /** tok/s. */
  value: number;
  /** `true` when the number is an estimate (chars/4). */
  estimated: boolean;
}

const turns = new Map<string, TurnSpeed>();

function key(id: string | null | undefined): string {
  return id || "";
}

function entry(id: string | null | undefined): TurnSpeed {
  const k = key(id);
  let e = turns.get(k);
  if (!e) {
    e = { samples: [], lastAt: 0 };
    turns.set(k, e);
  }
  return e;
}

/** New turn: forget live samples for this session. */
export function resetSpeed(id: string | null | undefined): void {
  turns.delete(key(id));
}

/** A streamed text chunk (chars ≈ tokens × 4). */
export function noteChunk(
  id: string | null | undefined,
  text: string,
  now = Date.now(),
): void {
  if (!text) return;
  const e = entry(id);
  if (e.lastAt && now - e.lastAt > SPEED_PAUSE_MS) e.samples = [];
  e.lastAt = now;
  e.samples.push({ at: now, chars: text.length });
  prune(e, now);
}

function prune(e: TurnSpeed, now: number): void {
  while (e.samples.length && now - e.samples[0].at > SPEED_WINDOW_MS) e.samples.shift();
}

/** Live tok/s for the rail; null when the model is not writing. */
export function speedView(id: string | null | undefined, now = Date.now()): SpeedView | null {
  const e = turns.get(key(id));
  if (!e || !e.lastAt || now - e.lastAt > SPEED_PAUSE_MS) return null;
  prune(e, now);
  if (!e.samples.length) return null;
  const chars = e.samples.reduce((n, s) => n + s.chars, 0);
  // Floor the span: one chunk alone would otherwise read as infinite tok/s.
  const span = Math.max(now - e.samples[0].at, 250);
  const value = chars / CHARS_PER_TOKEN / (span / 1000);
  return value > 0 ? { value, estimated: true } : null;
}

/** One formatter for the rail and the final chip. */
export function speedText(value: number, estimated: boolean): string {
  const n = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return t(estimated ? "web.speed.estimated" : "web.speed.tps", { n });
}
