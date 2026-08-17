import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { downloadFileTool, MAX_DOWNLOAD_BYTES } from "../../src/tools/download-file";
import type { ToolContext } from "../../src/tools/types";
import type { AppConfig } from "../../src/config/types";

const TEST_DIR = join(import.meta.dirname || process.cwd(), "_test_download_file");

const originalFetch = globalThis.fetch;

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    config: {} as AppConfig,
    baseDir: TEST_DIR,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    ...overrides,
  };
}

function mockResponse(
  body: string | Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

function stubFetch(mock: ReturnType<typeof vi.fn>) {
  globalThis.fetch = mock as unknown as typeof fetch;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("download_file tool", () => {
  it("should have correct tool definition", () => {
    expect(downloadFileTool.name).toBe("download_file");
    expect(downloadFileTool.tags).toContain("file");
    expect(downloadFileTool.parameters.required).toEqual(["url", "path"]);
  });

  it("should return error when url is missing", async () => {
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, { path: "x.bin" });
    expect(result.success).toBe(false);
  });

  it("should return error when path is missing", async () => {
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, { url: "https://example.com/x.bin" });
    expect(result.success).toBe(false);
  });

  it("should download a binary file and write it to disk", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    stubFetch(
      vi.fn().mockResolvedValue(mockResponse(bytes, 200, { "content-type": "image/jpeg" })),
    );

    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://images.example.com/photo.jpg",
      path: "img/photo.jpg",
    });

    expect(result.success).toBe(true);
    const file = join(TEST_DIR, "img", "photo.jpg");
    expect(existsSync(file)).toBe(true);
    expect(Buffer.from(readFileSync(file)).equals(Buffer.from(bytes))).toBe(true);
    expect(result.output).toContain("photo.jpg");
    expect(result.output).toContain("10");
    // Metadata only — never dump binary content into the model context.
    expect(result.output).not.toContain("ÿØ");
    expect(result.output.length).toBeLessThan(300);
  });

  it("should create intermediate directories", async () => {
    stubFetch(vi.fn().mockResolvedValue(mockResponse("data")));
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/a/b/c.txt",
      path: "deep/nested/dir/file.txt",
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(TEST_DIR, "deep", "nested", "dir", "file.txt"))).toBe(true);
  });

  it("should overwrite an existing file", async () => {
    stubFetch(vi.fn().mockResolvedValue(mockResponse("new")));
    const file = join(TEST_DIR, "x.txt");
    writeFileSync(file, "old");
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/x.txt",
      path: "x.txt",
    });
    expect(result.success).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("new");
  });

  it("should return error on HTTP error status", async () => {
    stubFetch(vi.fn().mockResolvedValue(mockResponse("nope", 404)));
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/missing.png",
      path: "missing.png",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("404");
    expect(existsSync(join(TEST_DIR, "missing.png"))).toBe(false);
  });

  it("should return error when the fetch throws", async () => {
    stubFetch(vi.fn().mockRejectedValue(new Error("network down")));
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/x.png",
      path: "x.png",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("network down");
  });

  it("should block URLs denied by network security", async () => {
    const config = {
      security: {
        network: {
          enabled: true,
          deniedDomains: ["evil.example.com"],
          allowedDomains: [],
          requestTimeout: 5000,
          maxResponseSize: 15000,
        },
      },
    } as unknown as AppConfig;
    const mock = vi.fn().mockResolvedValue(mockResponse("x"));
    stubFetch(mock);

    const ctx = makeCtx({ config });
    const result = await downloadFileTool.handler(ctx, {
      url: "https://evil.example.com/virus.exe",
      path: "virus.exe",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("SECURITY BLOCKED");
    expect(mock).not.toHaveBeenCalled();
  });

  it("should block paths outside the base directory", async () => {
    stubFetch(vi.fn().mockResolvedValue(mockResponse("x")));
    const outside = join(TEST_DIR, "..", "_outside_download_file");
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/x.txt",
      path: outside,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not allowed");
  });

  it("should respect sub-agent writable scope", async () => {
    stubFetch(vi.fn().mockResolvedValue(mockResponse("x")));
    const ctx = makeCtx({
      scope: { allowed_files: ["allowed/"], read_only_files: [] },
    });
    const ok = await downloadFileTool.handler(ctx, {
      url: "https://example.com/x.txt",
      path: "allowed/x.txt",
    });
    expect(ok.success).toBe(true);

    const blocked = await downloadFileTool.handler(ctx, {
      url: "https://example.com/y.txt",
      path: "other/y.txt",
    });
    expect(blocked.success).toBe(false);
  });

  it("should block downloads larger than the max size via content-length", async () => {
    stubFetch(
      vi
        .fn()
        .mockResolvedValue(
          mockResponse("", 200, { "content-length": String(MAX_DOWNLOAD_BYTES + 1) }),
        ),
    );
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/huge.bin",
      path: "huge.bin",
    });
    expect(result.success).toBe(false);
    expect(existsSync(join(TEST_DIR, "huge.bin"))).toBe(false);
  });

  it("should block downloads larger than the max size when no content-length header", async () => {
    const big = new Uint8Array(MAX_DOWNLOAD_BYTES + 1);
    stubFetch(vi.fn().mockResolvedValue(mockResponse(big)));
    const ctx = makeCtx();
    const result = await downloadFileTool.handler(ctx, {
      url: "https://example.com/chunked.bin",
      path: "chunked.bin",
    });
    expect(result.success).toBe(false);
  });
});
