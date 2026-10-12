// Форматирование событий в строки вида `[LEVEL] [source] ISO — text`.
import { createColors } from "picocolors";
import { sourceLabel } from "./source";
import type { OutputEvent, OutputLevel } from "./types";

const colored = createColors(true);

const LEVEL_COLORS: Record<OutputLevel, (s: string) => string> = {
  debug: (s) => colored.dim(s),
  info: (s) => s,
  warn: (s) => colored.yellow(s),
  error: (s) => colored.red(s),
};

/** Форматирует событие как в legacy-логере: `[LEVEL] [source] ISO — text`. */
export function formatEventLine(ev: OutputEvent, color: boolean): string {
  // В терминал — короткая метка владельца (`module:indexer` → `indexer`);
  // канонический `Source` остаётся в событии для машинных стоков (INV-13).
  const label = sourceLabel(ev.source);
  const prefix = label ? ` [${label}]` : "";
  const line = `[${ev.level.toUpperCase()}]${prefix} ${new Date(ev.ts).toISOString()} — ${ev.text}`;
  return color ? LEVEL_COLORS[ev.level](line) : line;
}
