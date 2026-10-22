/**
 * Установка релиза из GitHub Releases: проверка манифеста, staged-копирование
 * и переключение `~/.mma/current`.
 *
 * Целостность обязательна: манифест без `sha256`/`size` не ставится. Живая
 * версия не удаляется до успешного flip; распаковка проверяет список членов
 * архива (никаких `..`/абсолютных путей/симлинков).
 *
 * Транспорт (скачивание/распаковка) — `./archive.ts`. Чистые, инжектируемые
 * функции — тестируются на временных каталогах без сети.
 */
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { FetchLike, ReleaseArtifact, ReleaseManifest, ReleasePlatformKey } from "./release";
import { downloadCap, downloadFile, extractTarGz, sha256File, type InstallProgressFn } from "./archive";

export {
  assertSafeTarMembers,
  downloadFile,
  extractTarGz,
  sha256File,
  type InstallProgress,
  type InstallProgressFn,
} from "./archive";

/** Стадия установки (порядок важен: `stage` строго до `flip`). */
export type InstallStep = "stage" | "flip" | "cleanup-old";

export interface InstallReleaseOptions {
  manifest: ReleaseManifest;
  key: ReleasePlatformKey;
  /** База скачивания (без слэша на конце). */
  base: string;
  fetchImpl: FetchLike;
  /** Корень установки (`~/.mma`). */
  installRoot: string;
  /** Распаковка tarball'а (инжект для тестов). */
  extract?: (tarball: string, dest: string) => Promise<void>;
  /** Наблюдатель шагов установки (порядок stage→flip→cleanup-old). */
  onStep?: (step: InstallStep) => void;
}

/** Скачивает релиз, распаковывает и активирует. Возвращает версию. */
export async function installRelease(
  opts: InstallReleaseOptions,
  onProgress?: InstallProgressFn,
): Promise<string> {
  const artifact = opts.manifest.artifacts[opts.key];
  if (!artifact) throw new Error(`platform ${opts.key} is not in the manifest`);
  assertArtifact(artifact);
  assertArtifactName(artifact.url);

  const tmp = await mkdtemp(join(tmpdir(), "mma-update-"));
  try {
    const tarball = join(tmp, "mma.tar.gz");
    onProgress?.({ phase: "download" });
    await downloadFile(
      `${opts.base}/${artifact.url}`,
      tarball,
      opts.fetchImpl,
      onProgress,
      downloadCap(artifact.size),
    );

    onProgress?.({ phase: "verify" });
    const actual = await sha256File(tarball);
    if (actual !== artifact.sha256.toLowerCase()) {
      throw new Error(`checksum mismatch (expected ${artifact.sha256}, got ${actual})`);
    }
    const actualSize = (await stat(tarball)).size;
    if (actualSize !== artifact.size) {
      throw new Error(`size mismatch (expected ${artifact.size}, got ${actualSize})`);
    }

    onProgress?.({ phase: "extract" });
    const pkg = join(tmp, "pkg");
    await mkdir(pkg, { recursive: true });
    await (opts.extract ?? extractTarGz)(tarball, pkg);

    const version = readVersion(await readFile(join(pkg, "VERSION"), "utf8"));
    onProgress?.({ phase: "activate" });

    const versionsDir = join(opts.installRoot, "versions");
    await mkdir(versionsDir, { recursive: true });
    const target = join(versionsDir, version);
    await assertNotLive(opts.installRoot, target);

    // Staging рядом с целевым каталогом: rename атомарен в пределах тома.
    const staging = join(versionsDir, `${version}.tmp`);
    await rm(staging, { recursive: true, force: true });
    await cp(pkg, staging, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    opts.onStep?.("stage");

    const previous = await flipCurrent(opts.installRoot, target);
    opts.onStep?.("flip");

    if (previous && !samePath(previous, target)) {
      await rm(previous, { recursive: true, force: true });
      opts.onStep?.("cleanup-old");
    }
    return version;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Артефакт обязан нести проверяемые `sha256` (64 hex) и `size`. */
function assertArtifact(artifact: ReleaseArtifact): void {
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(artifact.sha256)) {
    throw new Error("manifest has no valid checksum (sha256)");
  }
  if (!Number.isFinite(artifact.size) || artifact.size <= 0) {
    throw new Error("manifest has no artifact size");
  }
}

/**
 * Имя артефакта в манифесте — относительное, без `..` и без схемы: иначе
 * `${base}/${artifact.url}` уводит скачивание на чужой хост/абсолютный путь.
 */
export function assertArtifactName(name: string): void {
  const unsafe =
    !name ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[a-z]:/i.test(name) ||
    /^[a-z][a-z0-9+.-]*:/i.test(name) ||
    name.split(/[\\/]/).includes("..");
  if (unsafe) throw new Error(`unsafe artifact url: ${name}`);
}

/** Версия из архива становится компонентом пути — допускаем только безопасный вид. */
function readVersion(raw: string): string {
  const version = raw.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version) || version === "." || version === "..") {
    throw new Error(`invalid archive: unsafe VERSION "${version}"`);
  }
  return version;
}

/** Не даём «переустановить» версию, на которую сейчас указывает `current`. */
async function assertNotLive(root: string, target: string): Promise<void> {
  const live = await currentTarget(join(root, "current"));
  if (live && samePath(live, target)) throw new Error(`version is already active: ${basename(target)}`);
}

/** Сравнение путей ссылки и цели (Windows junction отдаёт `\\?\`-префикс). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const stripped = p.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
    return process.platform === "win32" ? stripped.replace(/\\/g, "/").toLowerCase() : stripped;
  };
  return norm(a) === norm(b);
}

/**
 * Переключает `~/.mma/current` на новую версию: сначала создаётся ссылка
 * `.current.new`, затем `current` уводится в `.current.old`, новая ссылка
 * встаёт на место, старая удаляется. Окно без `current` минимально, а сама
 * целевая версия уже распакована и проверена.
 * Возвращает предыдущую цель ссылки (её удаляет вызывающий после flip).
 */
async function flipCurrent(root: string, target: string): Promise<string | undefined> {
  const current = join(root, "current");
  const staged = join(root, ".current.new");
  const old = join(root, ".current.old");
  await removePath(staged);
  await removePath(old);
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(target, staged, type);

  const previous = await currentTarget(current);
  let moved = false;
  try {
    await rename(current, old);
    moved = true;
  } catch (err) {
    // Нет current — первый запуск/починка после сбоя; прочие ошибки важны.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await rename(staged, current);
  if (moved) await removePath(old);
  return previous;
}

/** Куда указывает `current` (undefined — ссылки нет). */
async function currentTarget(current: string): Promise<string | undefined> {
  try {
    return await readlink(current);
  } catch {
    return undefined;
  }
}

/** Удаляет ссылку или каталог, не задевая цель ссылки. */
async function removePath(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) await unlink(path);
    else await rm(path, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
