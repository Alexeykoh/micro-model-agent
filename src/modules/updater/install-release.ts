/**
 * Установка релиза из GitHub Releases: скачивание артефакта, проверка sha256,
 * распаковка и переключение `~/.mma/current`.
 *
 * Чистые, инжектируемые функции — тестируются на временных каталогах без сети
 * (fetch и распаковка передаются параметрами).
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike, ReleaseManifest, ReleasePlatformKey } from "./release";

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
}

/** Стадия установки для прогресса в UI/консоли. */
export interface InstallProgress {
  phase: "download" | "verify" | "extract" | "activate";
  /** Скачано байт (только `download`). */
  received?: number;
  /** Всего байт, если известен `content-length` (только `download`). */
  total?: number;
}

/** Колбэк прогресса установки (best-effort, не влияет на результат). */
export type InstallProgressFn = (p: InstallProgress) => void;

/** Скачивает релиз, распаковывает и активирует. Возвращает версию. */
export async function installRelease(
  opts: InstallReleaseOptions,
  onProgress?: InstallProgressFn,
): Promise<string> {
  const artifact = opts.manifest.artifacts[opts.key];
  if (!artifact) throw new Error(`platform ${opts.key} is not in the manifest`);

  const tmp = await mkdtemp(join(tmpdir(), "mma-update-"));
  try {
    const tarball = join(tmp, "mma.tar.gz");
    onProgress?.({ phase: "download" });
    await downloadFile(`${opts.base}/${artifact.url}`, tarball, opts.fetchImpl, onProgress);

    onProgress?.({ phase: "verify" });
    const actual = await sha256File(tarball);
    if (artifact.sha256 && actual !== artifact.sha256.toLowerCase()) {
      throw new Error(`checksum mismatch (expected ${artifact.sha256}, got ${actual})`);
    }

    onProgress?.({ phase: "extract" });
    const pkg = join(tmp, "pkg");
    await mkdir(pkg, { recursive: true });
    await (opts.extract ?? extractTarGz)(tarball, pkg);

    const version = (await readFile(join(pkg, "VERSION"), "utf8")).trim();
    if (!version) throw new Error("invalid archive: VERSION missing");

    onProgress?.({ phase: "activate" });
    const versionsDir = join(opts.installRoot, "versions");
    await mkdir(versionsDir, { recursive: true });
    const target = join(versionsDir, version);
    await rm(target, { recursive: true, force: true });
    await cp(pkg, target, { recursive: true });

    await flipCurrent(opts.installRoot, target);
    return version;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Скачивает файл целиком (релизы — десятки-сотни МБ). Читает `res.body`
 * потоком, чтобы отдавать прогресс по `content-length`; если тела нет
 * (некоторые моки/окружения) — обычный `arrayBuffer`.
 */
export async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: FetchLike,
  onProgress?: InstallProgressFn,
): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const lenHeader = res.headers && typeof res.headers.get === "function"
    ? res.headers.get("content-length")
    : null;
  const total = Number(lenHeader) || undefined;
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        onProgress?.({ phase: "download", received, total });
      }
    }
    await writeFile(dest, Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

/** sha256 файла (hex, нижний регистр). */
export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Распаковка `.tar.gz` системным `tar` (есть на Windows 10+, macOS, Linux). */
export function extractTarGz(tarball: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xzf", tarball, "-C", dest], { windowsHide: true }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Переключает `~/.mma/current` на распакованную версию. */
async function flipCurrent(root: string, target: string): Promise<void> {
  const current = join(root, "current");
  await removeCurrent(current);
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(target, current, type);
}

/** Удаляет старый `current` (ссылка/junction), не задевая цель. */
async function removeCurrent(current: string): Promise<void> {
  try {
    const st = await lstat(current);
    if (st.isSymbolicLink()) await unlink(current);
    else await rm(current, { recursive: true, force: true });
  } catch {
    // Нет current — переключать нечего.
  }
}
