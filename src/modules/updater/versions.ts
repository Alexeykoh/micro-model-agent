// Домоводство `~/.mma/versions`: удаление каталогов версий и `current`-ярлыка.
//
// Вынесено из `install-release.ts` (правило 6): уборка нужна и после flip
// (доминирующий случай), и на старте — при обновлении на Windows каталог
// работающей версии занят `runtime/bun.exe`, `rm` падает с EACCES, и мусор
// дочищается только следующим запуском.
import { lstat, readlink, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Удаляет каталог версии; `false` — каталог занят/недоступен, это не ошибка. */
export type RemoveVersionDir = (path: string) => Promise<boolean>;

/** Удаление каталога версии без исключения: `false` — занят (Windows-лок). */
export async function removeVersionDirQuietly(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Удаляет все каталоги `versions/*`, кроме активного `target`, и брошенные
 * `*.tmp` после упавшей установки. Best-effort: занятые каталоги возвращаются
 * в списке как «отложенные». Вызывается после flip и на старте
 * ({@link pruneStaleVersions}), поэтому мусор от старых обновлений не копится.
 */
export async function sweepVersions(
  versionsDir: string,
  target: string,
  remove: RemoveVersionDir = removeVersionDirQuietly,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(versionsDir);
  } catch {
    return [];
  }
  const deferred: string[] = [];
  for (const name of entries) {
    const path = join(versionsDir, name);
    if (samePath(path, target)) continue;
    if (!(await remove(path))) deferred.push(name);
  }
  return deferred;
}

/** Что убирать и что трогать нельзя при стартовой уборке `versions/`. */
export interface PruneStaleVersionsOptions {
  /** Корень установки (`~/.mma`). */
  root: string;
  /** Каталоги, которые трогать нельзя (например, каталог запущенного кода). */
  keep?: string[];
  removeVersionDir?: RemoveVersionDir;
}

/**
 * Стартовая уборка `~/.mma/versions`: оставляет активную версию (`current`) и
 * `keep`, остальное удаляет. Возвращает имена удалённых и отложенных каталогов.
 */
export async function pruneStaleVersions(
  opts: PruneStaleVersionsOptions,
): Promise<{ removed: string[]; deferred: string[] }> {
  const versionsDir = join(opts.root, "versions");
  const active = await currentTarget(join(opts.root, "current"));
  const remove = opts.removeVersionDir ?? removeVersionDirQuietly;
  let entries: string[];
  try {
    entries = await readdir(versionsDir);
  } catch {
    return { removed: [], deferred: [] };
  }
  const removed: string[] = [];
  const deferred: string[] = [];
  for (const name of entries) {
    const path = join(versionsDir, name);
    if (active && samePath(path, active)) continue;
    if ((opts.keep ?? []).some((kept) => samePath(path, kept))) continue;
    if (await remove(path)) removed.push(name);
    else deferred.push(name);
  }
  return { removed, deferred };
}

/** Сравнение путей ссылки и цели (Windows junction отдаёт `\\?\`-префикс). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const stripped = p.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
    return process.platform === "win32" ? stripped.replace(/\\/g, "/").toLowerCase() : stripped;
  };
  return norm(a) === norm(b);
}

/** Куда указывает `current` (undefined — ссылки нет). */
export async function currentTarget(current: string): Promise<string | undefined> {
  try {
    return await readlink(current);
  } catch {
    return undefined;
  }
}

/** Удаляет ссылку или каталог, не задевая цель ссылки. */
export async function removePath(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) await unlink(path);
    else await rm(path, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
