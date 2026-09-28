import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeText, MAX_FILE_VIEW_BYTES, mimeForView, safeFileName } from "../src/modules/webui/file-api";
import { createWebUiState, } from "../src/modules/webui/state";
import { withServer, doFetch, } from "./helpers/webui-server";



const tmpRoots: string[] = [];
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-webui-file-"));
  tmpRoots.push(dir);
  return dir;
}

// Single entry for every `/api/file` server test: one workspace, one
// ephemeral server, zero repeated scaffolding (the quality gate flags
// copy-pasted test setups as duplication).
async function withFileApi(
  setup: { name: string; data: string | Buffer } | null,
  check: (get: (path: string) => Promise<Response>, ws: string) => Promise<void> | void,
  opts?: { noWorkspace?: boolean },
): Promise<void> {
  const ws = makeWorkspace();
  if (setup) writeFileSync(join(ws, setup.name), setup.data);
  const s = createWebUiState();
  if (!opts?.noWorkspace) s.workspace = ws;
  await withServer(s, async (base) => {
    await check((path) => doFetch(`${base}/api/file?path=${path}`), ws);
  });
}

// Creating file symlinks needs privileges/developer mode on Windows.
const canSymlink = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "mma-webui-sym-"));
    const target = join(dir, "t");
    writeFileSync(target, "x");
    symlinkSync(target, join(dir, "l"));
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

// Directory junctions work on Windows without an elevated shell.
const canLinkDir = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "mma-webui-junc-"));
    const target = join(dir, "t");
    mkdirSync(target);
    symlinkSync(target, join(dir, "l"), "junction");
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe("webui file viewer", () => {
  afterEach(() => {
    while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  });

  it("serves a text file inside the workspace", async () => {
    await withFileApi({ name: "note.md", data: "# hello" }, async (get, ws) => {
      const res = await get(encodeURIComponent(join(ws, "note.md")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("# hello");
    });
  });

  it("resolves a workspace-relative path", async () => {
    await withFileApi({ name: "rel.txt", data: "relative" }, async (get) => {
      const res = await get("rel.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("relative");
    });
  });

  it("answers plain-text errors so a new tab shows a readable message", async () => {
    await withFileApi(null, async (get) => {
      const res = await get("../../secret.txt");
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      // Locale-independent: a readable message, not JSON and not a leaked key.
      expect(body.startsWith("{")).toBe(false);
      expect(body).not.toContain("web.file.error");
    });
  });

  it("rejects protected paths such as .env", async () => {
    await withFileApi({ name: ".env", data: "SECRET=1" }, async (get, ws) => {
      const res = await get(encodeURIComponent(join(ws, ".env")));
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).not.toContain("web.file.error");
    });
  });

  it.skipIf(!canSymlink)("refuses a symlink that escapes the workspace", async () => {
    const ws = makeWorkspace();
    const outside = makeWorkspace();
    writeFileSync(join(outside, "secret.txt"), "top secret");
    const link = join(ws, "link.txt");
    symlinkSync(join(outside, "secret.txt"), link);
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/file?path=${encodeURIComponent(link)}`);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });
  });

  it.skipIf(!canLinkDir)("refuses a file reached through a linked directory", async () => {
    const ws = makeWorkspace();
    const outside = makeWorkspace();
    writeFileSync(join(outside, "secret.txt"), "top secret");
    const linkDir = join(ws, "linked");
    symlinkSync(outside, linkDir, "junction");
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const res = await doFetch(
        `${base}/api/file?path=${encodeURIComponent(join(linkDir, "secret.txt"))}`,
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("text/plain");
    });
  });

  it("serves a UTF-16LE text file", async () => {
    const setup = { name: "u16.txt", data: Buffer.from("﻿hello", "utf16le") };
    await withFileApi(setup, async (get) => {
      const res = await get("u16.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
    });
  });

  it("refuses a binary file with a readable message", async () => {
    const bin = { name: "bin.dat", data: Buffer.from([0x00, 0x01, 0x02, 0x00]) };
    await withFileApi(bin, async (get) => {
      const res = await get("bin.dat");
      const body = await res.text();
      expect(res.status).toBe(415);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(body).not.toContain("web.file.error");
    });
  });

  it("downloads a binary file as an attachment instead of refusing it", async () => {
    const bin = { name: "bin.dat", data: Buffer.from([0x00, 0x01, 0x02, 0x00]) };
    await withFileApi(bin, async (get) => {
      const res = await get("bin.dat&download=1");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/octet-stream");
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      expect(disposition).toContain("bin.dat");
      expect((await res.arrayBuffer()).byteLength).toBe(4);
    });
  });

  it("downloads a text file as an attachment with the file name", async () => {
    await withFileApi({ name: "note.md", data: "# hello" }, async (get) => {
      const res = await get("note.md&download=1");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/octet-stream");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(await res.text()).toBe("# hello");
    });
  });

  it("previews safe raster images with their native MIME type", async () => {
    // Minimal 1x1 PNG; binary on purpose — the viewer must not decode it.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    ]);
    await withFileApi({ name: "dot.png", data: png }, async (get) => {
      const res = await get("dot.png");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
      expect(res.headers.get("content-disposition")).toBeNull();
    });
  });

  it("keeps svg/html as text so model-written markup cannot run scripts", () => {
    expect(mimeForView("pic.svg")).toContain("text/plain");
    expect(mimeForView("page.html")).toContain("text/plain");
    expect(mimeForView("dot.png")).toContain("image/png");
    expect(mimeForView("doc.pdf")).toContain("application/pdf");
    expect(mimeForView("schema.drawio")).toContain("text/plain");
    expect(safeFileName("/ws/a\"b\nc")).toBe("a_b_c");
  });

  it("refuses a file larger than the cap with 413 before reading", async () => {
    const big = { name: "big.txt", data: Buffer.alloc(MAX_FILE_VIEW_BYTES + 10, 0x61) };
    await withFileApi(big, async (get) => {
      const res = await get("big.txt");
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).not.toContain("web.file.error");
    });
  });

  it("answers a readable message for a directory", async () => {
    await withFileApi(null, async (get, ws) => {
      const res = await get(encodeURIComponent(ws));
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("web.file.error");
    });
  });

  it("answers 404 for a missing file and 400 without a path", async () => {
    await withFileApi(null, async (get) => {
      const missing = await get("nope.txt");
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toContain("text/plain");
      expect(await missing.text()).not.toContain("web.file.error");
      const noPath = await get("");
      expect(noPath.status).toBe(400);
      expect(noPath.headers.get("content-type")).toContain("text/plain");
      expect(await noPath.text()).not.toContain("web.file.error");
    });
  });

  it("answers 503 when no workspace is wired", async () => {
    await withFileApi(null, async (get) => {
      const res = await get("x.txt");
      expect(res.status).toBe(503);
    }, { noWorkspace: true });
  });
});

describe("decodeText", () => {
  it("handles BOMs, odd-length BE, NUL and plain text", () => {
    expect(decodeText(Buffer.from("\uFEFFhi", "utf16le"))).toEqual({ text: "hi", binary: false });
    expect(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toEqual({
      text: "hi",
      binary: false,
    });
    expect(() => decodeText(Buffer.from([0xfe, 0xff, 0x00]))).not.toThrow();
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68]))).toEqual({ text: "h", binary: false });
    expect(decodeText(Buffer.from([0x68, 0x00]))).toEqual({ text: "", binary: true });
    expect(decodeText(Buffer.from("ok"))).toEqual({ text: "ok", binary: false });
    expect(decodeText(Buffer.alloc(0))).toEqual({ text: "", binary: false });
  });
});
