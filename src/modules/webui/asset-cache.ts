// Кеш снапшота веб-ассетов (INV-W1, спека 2026-11-04-webui-latency-design).
//
// `assetSource` раньше был самим `loadAssets`: он читал и транспилировал все
// файлы фронта на КАЖДЫЙ статический запрос. Снапшот живёт в памяти и
// перечитывается, только когда изменилось дерево файлов (отпечаток) либо истёк
// TTL — правки в dev подхватываются, стоимость запроса от числа файлов не растёт.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { ASSET_DIR, ASSET_IS_SOURCE, loadAssets } from "./assets";
import type { WebUiAssets } from "./state";

/** TTL отпечатка в dev: правки ассетов цепляются без рестарта `mma web`. */
export const ASSET_TTL_DEV_MS = 500;

/** Источник статики: снапшот + его weak-ETag для `If-None-Match`. */
export interface AssetSourceHandle {
  /** Снапшот; один и тот же объект, пока дерево файлов не изменилось. */
  get: () => WebUiAssets;
  /** ETag снапшота; `undefined`, пока ассеты недоступны. */
  etag: () => string | undefined;
}

/** Зависимости, которые тесты подменяют; прод-поведение — по умолчанию. */
export interface AssetSourceOptions {
  /** Директория ассетов; `null` — отпечаток не считается (зафиксированный снапшот). */
  dir?: string | null;
  /** Сколько миллисекунд отпечаток считается актуальным. */
  ttlMs?: number;
  /** Читает снапшот с диска; по умолчанию `loadAssets`. */
  load?: () => WebUiAssets;
  now?: () => number;
}

/**
 * Отпечаток дерева: относительный путь, mtime и размер каждого файла.
 * Меняется при правке, добавлении или удалении файла; не зависит от содержимого
 * в памяти. `null` — каталога нет (заглушки, тестовые фикстуры).
 */
export function assetTreeFingerprint(dir: string | null): string | null {
  if (!dir || !existsSync(dir)) return null;
  const lines: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      try {
        const st = statSync(full);
        lines.push(`${rel}\t${st.mtimeMs}\t${st.size}`);
      } catch {
        // Файл исчез между readdir и stat — следующий отпечаток его не найдёт.
      }
    }
  };
  walk(dir, "");
  return lines.join("\n");
}

/** Строит источник статики поверх `loadAssets` с кешем по отпечатку и TTL. */
export function createAssetSource(opts: AssetSourceOptions = {}): AssetSourceHandle {
  const dir = opts.dir !== undefined ? opts.dir : (ASSET_DIR ?? null);
  // В prod ассеты бандла неизменны: TTL бесконечен, отпечаток считается один
  // раз — заодно даёт ETag для `304`. В dev перепроверка раз в ASSET_TTL_DEV_MS.
  const ttlMs = opts.ttlMs ?? (ASSET_IS_SOURCE ? ASSET_TTL_DEV_MS : Number.POSITIVE_INFINITY);
  const now = opts.now ?? Date.now;
  const load = opts.load ?? loadAssets;
  let snapshot: WebUiAssets | null = null;
  let fingerprint: string | null = null;
  let etag: string | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY;

  return {
    get: (): WebUiAssets => {
      const t = now();
      if (snapshot !== null && t - checkedAt < ttlMs) return snapshot;
      const fp = assetTreeFingerprint(dir);
      checkedAt = t;
      if (snapshot !== null && fp === fingerprint) return snapshot;
      snapshot = load();
      fingerprint = fp;
      etag = fp === null ? undefined : `W/"${createHash("sha1").update(fp).digest("base64url")}"`;
      return snapshot;
    },
    etag: () => etag,
  };
}
