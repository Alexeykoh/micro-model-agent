/**
 * Скачивание и распаковка релизного артефакта (W10.6).
 *
 * Вынесено из `install-release.ts` (правило 6): поток с жёстким капом, sha256 и
 * проверка списка членов архива — транспорт, а не логика установки.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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

/** Настройки скачивания: терпимость к медленной сети и обрывам. */
export interface DownloadOptions {
  /**
   * Пауза без данных, после которой попытка прерывается, мс. Общего лимита на
   * скачивание нет: 78 МБ на слабом канале легально идут дольше пяти минут.
   */
  idleTimeoutMs?: number;
  /** Всего попыток (первая + повторы с докачкой). */
  attempts?: number;
  /** Пауза перед повтором (номер попытки, 1-based → мс). */
  retryDelayMs?: (attempt: number) => number;
}

/** Состояние скачивания между попытками (докачка с этого же места). */
interface DownloadState {
  chunks: Uint8Array[];
  received: number;
}

/**
 * Скачивает файл целиком (релизы — десятки-сотни МБ) потоком с жёстким капом.
 * Кап берётся из `artifact.size` с запасом 10% + 1 МБ: манифест подписан, но
 * поток всё равно не должен уметь занять диск/память сверх заявленного.
 *
 * Таймаут — по простою потока (не на всё скачивание), обрыв продолжается
 * запросом `Range` с уже полученного байта. Целостность всё равно проверяет
 * вызывающий по `sha256`/`size`.
 */
export async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: FetchLike,
  onProgress?: InstallProgressFn,
  cap?: number,
  opts: DownloadOptions = {},
): Promise<void> {
  const idleMs = opts.idleTimeoutMs ?? 60_000;
  const attempts = Math.max(1, Math.trunc(opts.attempts ?? 3));
  const retryDelay = opts.retryDelayMs ?? ((n) => Math.min(4000, 500 * 2 ** (n - 1)));
  const state: DownloadState = { chunks: [], received: 0 };
  let lastError: Error = new Error("download failed");
  let usedAttempts = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    usedAttempts = attempt;
    try {
      await downloadAttempt(url, fetchImpl, state, cap, onProgress, idleMs);
      await writeFile(dest, Buffer.concat(state.chunks.map((c) => Buffer.from(c))));
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(lastError) || attempt >= attempts) break;
      await sleep(retryDelay(attempt));
    }
  }
  throw usedAttempts > 1
    ? new Error(`${lastError.message} (after ${usedAttempts} attempts)`)
    : lastError;
}

/** Одна попытка: читает поток с текущего места `state.received`. */
async function downloadAttempt(
  url: string,
  fetchImpl: FetchLike,
  state: DownloadState,
  cap: number | undefined,
  onProgress: InstallProgressFn | undefined,
  idleMs: number,
): Promise<void> {
  const wait = idleGuard(idleMs);
  const resuming = state.received > 0;
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: resuming ? { Range: `bytes=${state.received}-` } : {},
        signal: wait.signal,
      });
    } catch (err) {
      throw wait.wrap(err);
    }
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const partial = resuming && res.status === 206;
    if (partial) {
      const start = contentRangeStart(res);
      if (start !== state.received) {
        throw new Error(`download failed: unexpected content-range (start ${start ?? "?"})`);
      }
    } else if (resuming) {
      // Сервер проигнорировал `Range` — начинаем файл заново, а не склеиваем.
      state.chunks = [];
      state.received = 0;
    }
    const len = contentLength(res);
    const total = len === undefined ? undefined : partial ? state.received + len : len;
    if (cap !== undefined && total !== undefined && total > cap) {
      throw new Error(`download exceeds size cap (${total} > ${cap})`);
    }
    const body = res.body as ReadableStream<Uint8Array> | null | undefined;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          wait.touch();
          chunk = await reader.read();
        } catch (err) {
          await cancelReader(reader);
          throw wait.wrap(err);
        }
        if (chunk.done) break;
        const value = chunk.value;
        if (!value) continue;
        state.received += value.byteLength;
        if (cap !== undefined && state.received > cap) {
          await cancelReader(reader);
          throw new Error(`download exceeds size cap (${state.received} > ${cap})`);
        }
        state.chunks.push(value);
        onProgress?.({ phase: "download", received: state.received, total });
      }
      return;
    }
    let buf: Buffer;
    try {
      wait.touch();
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw wait.wrap(err);
    }
    state.received += buf.length;
    if (cap !== undefined && state.received > cap) {
      throw new Error(`download exceeds size cap (${state.received} > ${cap})`);
    }
    state.chunks.push(buf);
    onProgress?.({ phase: "download", received: state.received, total });
  } finally {
    wait.clear();
  }
}

/** Сторож простоя: таймер перезапускается перед каждым чтением. */
function idleGuard(idleMs: number): {
  signal: AbortSignal;
  touch(): void;
  clear(): void;
  wrap(err: unknown): Error;
} {
  const controller = new AbortController();
  let stalled = false;
  const arm = (): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleMs);
  let timer = arm();
  return {
    signal: controller.signal,
    touch() {
      clearTimeout(timer);
      timer = arm();
    },
    clear() {
      clearTimeout(timer);
    },
    wrap(err: unknown) {
      if (stalled) return new Error(`download stalled: no data for ${idleMs} ms`);
      return err instanceof Error ? err : new Error(String(err));
    },
  };
}

/** Повторяем сетевые/серверные отказы; кап и кривой `Range` — нет. */
export function isRetryable(error: Error): boolean {
  if (/size cap|content-range/i.test(error.message)) return false;
  const http = /HTTP (\d{3})/.exec(error.message);
  if (http) {
    const code = Number(http[1]);
    return code === 408 || code === 429 || code >= 500;
  }
  return true;
}

function contentLength(res: Response): number | undefined {
  const header = res.headers && typeof res.headers.get === "function"
    ? res.headers.get("content-length")
    : null;
  const len = Number(header);
  return Number.isFinite(len) && len > 0 ? len : undefined;
}

/** Начало диапазона из `content-range: bytes 100-199/200`. */
function contentRangeStart(res: Response): number | undefined {
  const header = res.headers && typeof res.headers.get === "function"
    ? res.headers.get("content-range")
    : null;
  const match = /^bytes\s+(\d+)-/i.exec(header ?? "");
  return match ? Number(match[1]) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

/**
 * Аргументы и cwd для `tar`: архив передаётся **basename** при `cwd` его
 * каталога. Абсолютный `C:\…` GNU-tar читает как `host:path` и падает с
 * «Cannot connect to C:» — так ломалась распаковка, если первым в PATH стоит
 * GNU tar (Git for Windows), а не bsdtar из System32.
 *
 * @param tarball путь к архиву; @param dest каталог распаковки.
 * @returns argv для листинга, argv для распаковки и cwd.
 */
export function tarPlan(
  tarball: string,
  dest: string,
): { cwd: string; list: string[]; extract: string[] } {
  const cwd = dirname(resolve(tarball));
  const name = basename(tarball);
  const extract = ["-xzf", name, "-C", resolve(dest)];
  // GNU/busybox понимают флаг, bsdtar на Windows — нет; владелец там не при чём.
  if (process.platform !== "win32") extract.push("--no-same-owner");
  return { cwd, list: ["-tzvf", name], extract };
}

/** Распаковка `.tar.gz` системным `tar` с проверкой списка членов архива. */
export async function extractTarGz(tarball: string, dest: string): Promise<void> {
  const { cwd, list, extract } = tarPlan(tarball, dest);
  const listing = await execTar(list, cwd);
  assertSafeTarMembers(listing);
  await execTar(extract, cwd);
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
function execTar(args: string[], cwd?: string): Promise<string> {
  const execOpts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(cwd ? { cwd } : {}) };
  return new Promise((resolveOut, reject) => {
    execFile("tar", args, execOpts, (err, stdout, stderr) =>
      err ? reject(new Error(`tar failed: ${stderr || err.message}`)) : resolveOut(stdout),
    );
  });
}
