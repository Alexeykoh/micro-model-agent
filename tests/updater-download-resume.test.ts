/**
 * Скачивание релиза терпит медленную сеть и обрывы: таймаут — по простою
 * потока, после обрыва запрос продолжается с полученного байта (`Range`).
 * Общий лимит в 300 с рубил легальную загрузку 78 МБ на слабом канале.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DownloadOptions, downloadFile, isRetryable } from "../src/modules/updater/archive";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function destPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mma-download-"));
  roots.push(root);
  return join(root, "artifact.bin");
}

const fast: DownloadOptions = { retryDelayMs: () => 0, idleTimeoutMs: 5_000 };

/** Поток: отдаёт `parts`, затем либо ошибка, либо конец. */
function streamOf(parts: Uint8Array[], failAtEnd?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) {
        controller.enqueue(parts[i++]);
      } else if (failAtEnd) {
        controller.error(failAtEnd);
      } else {
        controller.close();
      }
    },
  });
}

/** Поток, который никогда не отдаёт данных (проверка idle-таймаута). */
function stalledStream(signal?: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Настоящий fetch связывает тело с сигналом; фейк делает то же самое.
      signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
    },
  });
}

function response(init: {
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  length?: number;
  rangeStart?: number;
  buf?: Uint8Array;
}): Response {
  const headers = {
    get(name: string): string | null {
      const key = name.toLowerCase();
      if (key === "content-length") return init.length === undefined ? null : String(init.length);
      if (key === "content-range") {
        return init.rangeStart === undefined ? null : `bytes ${init.rangeStart}-/*`;
      }
      return null;
    },
  };
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers,
    body: init.body ?? null,
    arrayBuffer: async () => (init.buf ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

describe("downloadFile resilience", () => {
  it("resumes after a stream break instead of failing the whole install", async () => {
    const payload = Buffer.from("0123456789");
    const first = payload.subarray(0, 4);
    const rest = payload.subarray(4);
    const calls: Array<{ url: string; range?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      calls.push({ url: String(url), range });
      if (calls.length === 1) {
        return response({
          status: 200,
          length: payload.length,
          body: streamOf([first], new Error("socket hang up")),
        });
      }
      return response({ status: 206, rangeStart: first.length, length: rest.length, body: streamOf([rest]) });
    }) as unknown as typeof fetch;

    const dest = await destPath();
    await downloadFile("https://releases.example/mma.tar.gz", dest, fetchImpl as never, undefined, undefined, fast);

    expect(calls).toHaveLength(2);
    expect(calls[1].range).toBe("bytes=4-");
    expect((await readFile(dest)).toString()).toBe("0123456789");
  });

  it("restarts cleanly when the server ignores Range", async () => {
    const payload = Buffer.from("abcdef");
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return response({
          status: 200,
          length: payload.length,
          body: streamOf([payload.subarray(0, 2)], new Error("reset")),
        });
      }
      return response({ status: 200, length: payload.length, body: streamOf([payload]) });
    }) as unknown as typeof fetch;

    const dest = await destPath();
    await downloadFile("https://releases.example/x", dest, fetchImpl as never, undefined, undefined, fast);
    expect((await readFile(dest)).toString()).toBe("abcdef");
  });

  it("aborts a stalled stream by idle timeout and retries", async () => {
    const payload = Buffer.from("fresh");
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++;
      if (calls === 1) return response({ status: 200, body: stalledStream(init?.signal ?? undefined) });
      return response({ status: 200, length: payload.length, body: streamOf([payload]) });
    }) as unknown as typeof fetch;

    const dest = await destPath();
    await downloadFile("https://releases.example/x", dest, fetchImpl as never, undefined, undefined, {
      retryDelayMs: () => 0,
      idleTimeoutMs: 20,
    });
    expect(calls).toBe(2);
    expect((await readFile(dest)).toString()).toBe("fresh");
  });

  it("does not retry deterministic failures (HTTP 404, size cap)", async () => {
    let calls = 0;
    const notFound = (async () => {
      calls++;
      return response({ status: 404 });
    }) as unknown as typeof fetch;
    const dest = await destPath();
    await expect(
      downloadFile("https://releases.example/x", dest, notFound as never, undefined, undefined, fast),
    ).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);

    let capped = 0;
    const big = (async () => {
      capped++;
      return response({ status: 200, buf: new Uint8Array(64) });
    }) as unknown as typeof fetch;
    await expect(
      downloadFile("https://releases.example/x", dest, big as never, undefined, 10, fast),
    ).rejects.toThrow(/size cap/i);
    expect(capped).toBe(1);
  });

  it("reports attempts in the final error", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const dest = await destPath();
    await expect(
      downloadFile("https://releases.example/x", dest, fetchImpl as never, undefined, undefined, {
        attempts: 3,
        retryDelayMs: () => 0,
      }),
    ).rejects.toThrow(/offline \(after 3 attempts\)/);
  });
});

describe("isRetryable", () => {
  it("retries network faults and 5xx, not 4xx or cap violations", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
    expect(isRetryable(new Error("download failed: HTTP 503"))).toBe(true);
    expect(isRetryable(new Error("download failed: HTTP 429"))).toBe(true);
    expect(isRetryable(new Error("download failed: HTTP 404"))).toBe(false);
    expect(isRetryable(new Error("download exceeds size cap (2 > 1)"))).toBe(false);
    expect(isRetryable(new Error("download failed: unexpected content-range (start ?)"))).toBe(false);
  });
});
