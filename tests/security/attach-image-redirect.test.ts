import { describe, it, expect } from "vitest";
import {
  loadUrlAsDataUrl,
  ImageDownloadError,
  MAX_IMAGE_DOWNLOAD_BYTES,
} from "../../src/llm/image-utils";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";

/**
 * Загрузка картинки по URL: каждый хоп редиректа перепроверяется против
 * SSRF-политики, размер ограничен (аудит §2.5, план
 * `2026-10-12-harness-module-audit-fixes`, W4/Task 4.3).
 */

const net = DEFAULT_SECURITY_CONFIG.network;

function mockFetchChain(
  responses: Array<{ status: number; location?: string; body?: string; headers?: Record<string, string> }>,
): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body ?? "", {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as typeof fetch;
}

describe("loadUrlAsDataUrl", () => {
  it("revalidates every redirect hop", async () => {
    const fetchImpl = mockFetchChain([
      { status: 302, headers: { location: "http://127.0.0.1/x" } },
      { status: 200 },
    ]);
    await expect(
      loadUrlAsDataUrl("https://public.example/i.png", { securityConfig: net, fetchImpl }),
    ).rejects.toThrow();
  });

  it("caps the download", async () => {
    const fetchImpl = mockFetchChain([
      {
        status: 200,
        headers: { "content-length": String(MAX_IMAGE_DOWNLOAD_BYTES + 1) },
      },
    ]);
    const err = await loadUrlAsDataUrl("https://x/big", {
      securityConfig: net,
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageDownloadError);
    expect((err as ImageDownloadError).code).toBe("response_too_large");
  });

  it("reports an HTTP error with a code", async () => {
    const fetchImpl = mockFetchChain([{ status: 404 }]);
    const err = await loadUrlAsDataUrl("https://x/missing.png", {
      securityConfig: net,
      fetchImpl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageDownloadError);
    expect((err as ImageDownloadError).code).toBe("http_error");
  });
});
