/**
 * Сверка кэша корпуса с инвентарём каталога (INV-D4/D5). Отдельно от обхода
 * (`corpus.ts`), чтобы держать файлы ≤300 строк: `reconcile` переиспользует
 * неизменившиеся записи, пересобирает добавленные/изменённые и отбрасывает
 * исчезнувшие.
 */
import { chunkIR } from "./chunks";
import type { DocEntry, InventoryItem } from "./corpus";
import { parseCtx, type DocumentRegistry } from "./registry";
import { fileSource } from "./source";
import type { Logger } from "../../logger/app-logger";

/** Опции сверки кэша с инвентарём. */
export interface ReconcileOptions {
  baseDir: string;
  registry: DocumentRegistry;
  logger: Logger;
  maxChunkChars?: number;
  maxChunksPerDoc?: number;
}

/** Итог сверки: актуальные записи и число добавленных/изменённых/удалённых. */
export interface ReconcileResult {
  entries: DocEntry[];
  changed: number;
}

/**
 * Сводит кэш с инвентарём (INV-D4/D5): совпавшие по `path`/`mtimeMs`/`size`
 * записи переиспользуются; добавленные и изменённые пересобираются; отсутствующие
 * в инвентаре отбрасываются. Порядок — как в инвентаре; `changed` считает
 * добавленные + изменённые + удалённые. Вызывающий сохраняет кэш, только если
 * `changed > 0` и результат непуст: пустой снимок не сохраняем (иначе каталог
 * навсегда выглядит пустым).
 */
export async function reconcile(
  cached: DocEntry[],
  items: InventoryItem[],
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const chunkOpts = { maxChunkChars: opts.maxChunkChars, maxChunksPerDoc: opts.maxChunksPerDoc };
  const byPath = new Map(cached.map((e) => [e.path, e]));
  const live = new Set(items.map((i) => i.path));
  const entries: DocEntry[] = [];
  let changed = 0;
  for (const it of items) {
    const prev = byPath.get(it.path);
    if (prev && prev.mtimeMs === it.mtimeMs && prev.size === it.size) {
      entries.push(prev);
      continue;
    }
    changed += 1;
    try {
      const ir = await opts.registry.parse(parseCtx(opts.logger), fileSource(opts.baseDir, it.rel));
      entries.push({
        path: it.path,
        rel: it.rel,
        mtimeMs: it.mtimeMs,
        size: it.size,
        outline: ir.outline.map((n) => n.title),
        chunks: chunkIR(ir, chunkOpts),
      });
    } catch {
      // Стал неподдержанным/битым — запись не добавляем, но изменение учтено.
    }
  }
  for (const e of cached) if (!live.has(e.path)) changed += 1;
  return { entries, changed };
}
