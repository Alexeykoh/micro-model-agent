import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebUiState } from "../../../src/modules/webui/state";
import { listDir, MAX_DIR_ENTRIES } from "../../../src/modules/webui/file/files-api";
import { withServer, doFetch } from "../../helpers/webui-server";

const tmpRoots: string[] = [];
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-webui-files-"));
  tmpRoots.push(dir);
  return dir;
}

async function withFilesApi(
  ws: string,
  check: (base: string) => Promise<void>,
  noWorkspace = false,
): Promise<void> {
  const s = createWebUiState();
  if (!noWorkspace) s.workspace = ws;
  await withServer(s, check);
}

function filesUrl(base: string, rel: string): string {
  return `${base}/api/files?path=${encodeURIComponent(rel)}`;
}

describe("webui files listing", () => {
  afterEach(() => {
    while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  });

  it("lists dirs first, then files, alphabetically", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "b.txt"), "b");
    writeFileSync(join(ws, "a.txt"), "a");
    mkdirSync(join(ws, "zeta"));
    mkdirSync(join(ws, "alpha"));
    await withFilesApi(ws, async (base) => {
      const res = await doFetch(filesUrl(base, ""));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        path: string;
        entries: { name: string; type: string }[];
        truncated: boolean;
      };
      expect(body.path).toBe("");
      expect(body.truncated).toBe(false);
      expect(body.entries.map((e) => e.name)).toEqual(["alpha", "zeta", "a.txt", "b.txt"]);
      expect(body.entries[0].type).toBe("dir");
    });
  });

  it("lists a subdirectory when path is given", async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, "src"));
    writeFileSync(join(ws, "src", "index.ts"), "x");
    await withFilesApi(ws, async (base) => {
      const res = await doFetch(filesUrl(base, "src"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string; entries: { name: string; size?: number }[] };
      expect(body.path).toBe("src");
      expect(body.entries[0].name).toBe("index.ts");
      expect(typeof body.entries[0].size).toBe("number");
    });
  });

  it("hides IGNORE_DIRS, lockfiles and .gitignore entries", async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, "node_modules"));
    writeFileSync(join(ws, "bun.lock"), "x");
    writeFileSync(join(ws, "keep.txt"), "x");
    writeFileSync(join(ws, "ignored.txt"), "x");
    writeFileSync(join(ws, ".gitignore"), "ignored.txt\n");
    await withFilesApi(ws, async (base) => {
      const res = await doFetch(filesUrl(base, ""));
      const names = ((await res.json()) as { entries: { name: string }[] }).entries.map((e) => e.name);
      expect(names).toContain("keep.txt");
      expect(names).not.toContain("node_modules");
      expect(names).not.toContain("bun.lock");
      expect(names).not.toContain("ignored.txt");
    });
  });

  it("hides protected paths such as .env", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, ".env"), "SECRET=1");
    writeFileSync(join(ws, "ok.txt"), "x");
    await withFilesApi(ws, async (base) => {
      const names = ((await (await doFetch(filesUrl(base, ""))).json()) as { entries: { name: string }[] })
        .entries.map((e) => e.name);
      expect(names).toContain("ok.txt");
      expect(names).not.toContain(".env");
    });
  });

  it("truncates at MAX_DIR_ENTRIES", async () => {
    const ws = makeWorkspace();
    for (let i = 0; i < MAX_DIR_ENTRIES + 5; i++) {
      writeFileSync(join(ws, `f${String(i).padStart(5, "0")}.txt`), "");
    }
    const listing = await listDir(ws, ws);
    expect(listing.entries.length).toBe(MAX_DIR_ENTRIES);
    expect(listing.truncated).toBe(true);
  });

  it("rejects escapes and protected directories with JSON errors", async () => {
    const ws = makeWorkspace();
    await withFilesApi(ws, async (base) => {
      const escape = await doFetch(filesUrl(base, "../"));
      expect(escape.status).toBe(403);
      expect(((await escape.json()) as { error: string }).error).toBe("outside_workspace");

      mkdirSync(join(ws, ".git"));
      const git = await doFetch(filesUrl(base, ".git"));
      expect(git.status).toBe(403);
      expect(((await git.json()) as { error: string }).error).toBe("protected_path");
    });
  });

  it("answers 404 for a file path and 503 without a workspace", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "note.txt"), "x");
    await withFilesApi(ws, async (base) => {
      const file = await doFetch(filesUrl(base, "note.txt"));
      expect(file.status).toBe(404);
    });
    await withFilesApi(ws, async (base) => {
      const res = await doFetch(filesUrl(base, ""));
      expect(res.status).toBe(503);
    }, true);
  });
});
