import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

// Other tests in the shared process may stub globalThis.fetch; use the runtime's
// own fetch so HTTP assertions stay real.
const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

async function withServer(s: WebUiState, fn: (base: string) => Promise<void>): Promise<void> {
  const srv = createServer((req, res) => handleRequest(req, res, assets, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
}

const tmpRoots: string[] = [];
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-webui-file-"));
  tmpRoots.push(dir);
  return dir;
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
    const ws = makeWorkspace();
    writeFileSync(join(ws, "note.md"), "# hello");
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/file?path=" + encodeURIComponent(join(ws, "note.md")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("# hello");
    });
  });

  it("resolves a workspace-relative path", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "rel.txt"), "relative");
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/file?path=rel.txt");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("relative");
    });
  });

  it("rejects a path outside the workspace", async () => {
    const ws = makeWorkspace();
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/file?path=" + encodeURIComponent("../../secret.txt"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "outside_workspace" });
    });
  });

  it("rejects protected paths such as .env", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, ".env"), "SECRET=1");
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/file?path=" + encodeURIComponent(join(ws, ".env")));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "protected_path" });
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
      const res = await doFetch(base + "/api/file?path=" + encodeURIComponent(link));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "outside_workspace" });
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
        base + "/api/file?path=" + encodeURIComponent(join(linkDir, "secret.txt")),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "outside_workspace" });
    });
  });

  it("answers 404 for a missing file and 400 without a path", async () => {
    const ws = makeWorkspace();
    const s = createWebUiState();
    s.workspace = ws;
    await withServer(s, async (base) => {
      const missing = await doFetch(base + "/api/file?path=nope.txt");
      expect(missing.status).toBe(404);
      const noPath = await doFetch(base + "/api/file");
      expect(noPath.status).toBe(400);
    });
  });

  it("answers 503 when no workspace is wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/file?path=x.txt");
      expect(res.status).toBe(503);
    });
  });
});
