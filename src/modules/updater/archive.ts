/**
 * Скачивание и распаковка релизного артефакта (W10.6).
 *
 * Вынесено из `install-release.ts` (правило 6): поток с жёстким капом, sha256 и
 * проверка списка членов архива — транспорт, а не логика установки.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { FetchLike } from "./release";

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

/**
 * Скачивает файл целиком (релизы — десятки-сотни МБ) потоком с жёстким капом.
 * Кап берётся из `artifact.size` с запасом 10% + 1 МБ: манифест подписан, но
 * поток всё равно не должен уметь занять диск/память сверх заявленного.
 */
export async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: FetchLike,
  onProgress?: InstallProgressFn,
  cap?: number,
): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const lenHeader = res.headers && typeof res.headers.get === "function"
    ? res.headers.get("content-length")
    : null;
  const total = Number(lenHeader) || undefined;
  if (cap !== undefined && total !== undefined && total > cap) {
    throw new Error(`download exceeds size cap (${total} > ${cap})`);
  }
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (cap !== undefined && received > cap) {
          await cancelReader(reader);
          throw new Error(`download exceeds size cap (${received} > ${cap})`);
        }
        chunks.push(value);
        onProgress?.({ phase: "download", received, total });
      }
    }
    await writeFile(dest, Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (cap !== undefined && buf.length > cap) {
    throw new Error(`download exceeds size cap (${buf.length} > ${cap})`);
  }
  await writeFile(dest, buf);
}

/** Отменяет чтение; ошибка отмены не должна подменять причину отказа. */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch (err) {
    void err;
  }
}

/** Кап скачивания для заявленного размера (10% + 1 МБ). */
export function downloadCap(size: number): number {
  return Math.ceil(size * 1.1) + 1024 * 1024;
}

/** sha256 файла (hex, нижний регистр). */
export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Распаковка `.tar.gz` системным `tar` с проверкой списка членов архива. */
export async function extractTarGz(tarball: string, dest: string): Promise<void> {
  const listing = await execTar(["-tzvf", tarball]);
  assertSafeTarMembers(listing);
  const flags = ["-xzf", tarball, "-C", dest];
  // GNU/busybox понимают флаг, bsdtar на Windows — нет; владелец там не при чём.
  if (process.platform !== "win32") flags.push("--no-same-owner");
  await execTar(flags);
}

/**
 * Проверяет `tar -tvzf`: запрещены абсолютные пути, `..`-сегменты и любые
 * не-файлы/не-каталоги (симлинки/хардлинки могут вывести запись за `dest`).
 */
export function assertSafeTarMembers(listing: string): void {
  for (const line of listing.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`refusing archive member of type "${type}"`);
    }
    // Имя — последний токен строки (дата/размер/владелец идут раньше).
    const name = line.trim().split(/\s+/).at(-1) ?? "";
    const normalized = name.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[a-z]:/i.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`refusing unsafe archive member: ${name}`);
    }
  }
}

/** Запускает `tar` и возвращает stdout (stderr — в текст ошибки). */
function execTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`tar failed: ${stderr || err.message}`)) : resolve(stdout),
    );
  });
}
