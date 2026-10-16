/**
 * Источник документа по пути относительно `baseDir` (INV-D5): ленивое чтение
 * байтов по запросу обработчика. Байты читаются ровно один раз на разбор —
 * `registry.parse` (head) и обработчик делят один и тот же промис.
 */
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { t } from "../../i18n/index";
import type { DocSource } from "./handler";

/** Источник документа по пути относительно baseDir. */
export function fileSource(baseDir: string, raw: string): DocSource {
  const path = resolve(baseDir, raw);
  let cached: Promise<Uint8Array> | undefined;
  const bytes = (): Promise<Uint8Array> => {
    cached ??= readFile(path).catch((err: unknown) => {
      throw new Error(readError(raw, err));
    });
    return cached;
  };
  return { path, display: raw, ext: extname(path).toLowerCase(), bytes };
}

/** Дружелюбная причина чтения — с относительным путём, без абсолютного (INV-D5). */
function readError(raw: string, err: unknown): string {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return t("documents.file_not_found", { path: raw });
  }
  return err instanceof Error ? err.message : String(err);
}
