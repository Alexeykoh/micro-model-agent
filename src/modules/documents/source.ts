/**
 * Источник документа по пути относительно `baseDir` (INV-D5): ленивое чтение
 * байтов по запросу обработчика.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { DocSource } from "./handler";

/** Источник документа по пути относительно baseDir. */
export function fileSource(baseDir: string, raw: string): DocSource {
  const path = resolve(baseDir, raw);
  return { path, ext: extname(path).toLowerCase(), bytes: () => readFile(path) };
}
