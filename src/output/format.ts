import { createColors } from "picocolors";
import type { OutputEvent, OutputLevel } from "./types";

const colored = createColors(true);

const LEVEL_COLORS: Record<OutputLevel, (s: string) => string> = {
  debug: (s) => colored.dim(s),
  info: (s) => s,
  warn: (s) => colored.yellow(s),
  error: (s) => colored.red(s),
};

/** Reproduces the legacy Logger format: `[LEVEL] [source] ISO — text`. */
export function formatEventLine(ev: OutputEvent, color: boolean): string {
  const prefix = ev.source ? ` [${ev.source}]` : "";
  const line = `[${ev.level.toUpperCase()}]${prefix} ${new Date(ev.ts).toISOString()} — ${ev.text}`;
  return color ? LEVEL_COLORS[ev.level](line) : line;
}
