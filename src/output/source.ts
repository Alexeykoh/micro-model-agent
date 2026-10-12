// Хелперы источника события (INV-13): канонические `module:<name>`/`tool:<name>`
// и короткая метка владельца для терминального рендера.
import type { Source } from "./types";

/** Источник-модуль: `module:<name>`. */
export function moduleSource(name: string): Source {
  return `module:${name}`;
}

/** Источник-тул: `tool:<name>`. */
export function toolSource(name: string): Source {
  return `tool:${name}`;
}

/**
 * Короткая метка владельца для терминала: снимает префикс `module:`/`tool:`
 * (`module:indexer` → `indexer`, `tool:bash` → `bash`), `mma`/`core` — как есть.
 * Канонический `source` остаётся в событии (машиночитаемые стоки видят его целиком).
 */
export function sourceLabel(source: Source): string {
  const idx = source.indexOf(":");
  return idx >= 0 ? source.slice(idx + 1) : source;
}
