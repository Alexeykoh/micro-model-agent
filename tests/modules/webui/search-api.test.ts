import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebUiState } from "../../../src/modules/webui/state";
import {
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_QUERY,
  MAX_SEARCH_RESULTS,
  searchWorkspace,
} from "../../../src/modules/webui/file/search";
import { withServer, doFetch } from "../../helpers/webui-server";

const tmpRoots: string[] = [];
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-webui-search-"));
  tmpRoots.push(dir);
  return dir;
}

async function withSearchApi(
  ws: string | null,
  check: (base: string) => Promise<void>,
): Promise<void> {
  const s = createWebUiState();
  if (ws) s.workspace = ws;
  await withServer(s, check);
}

function searchUrl(base: string, q: string, extra = ""): string {
  return `${base}/api/search?q=${encodeURIComponent(q)}${extra}`;
}

interface SearchBody {
  results: (
    { kind: "path"; path: string } | { kind: "content"; path: string; line: number; text: string }
  )[];
  truncated: boolean;
  ms: number;
  scanned: number;
}

describe("webui content search", () => {
  afterEach(() => {
    while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  });

  it("finds matches with 1-based line numbers, case-insensitively, trimmed", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "a.txt"), "line one\nconst needle = 1\nLAST NEEDLE here\n");
    await withSearchApi(ws, async (base) => {
      const res = await doFetch(searchUrl(base, "needle"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as SearchBody;
      expect(body.results).toEqual([
        { kind: "content", path: "a.txt", line: 2, text: "const needle = 1" },
        { kind: "content", path: "a.txt", line: 3, text: "LAST NEEDLE here" },
      ]);
      expect(body.truncated).toBe(false);
      expect(body.ms).toBeGreaterThanOrEqual(0);
      expect(body.scanned).toBe(1);
    });
  });

  it("walks subdirectories and returns workspace-relative posix paths", async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, "src", "deep"), { recursive: true });
    writeFileSync(join(ws, "src", "deep", "b.ts"), "   padded needle   \n");
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "needle"))).json()) as SearchBody;
      expect(body.results).toEqual([
        { kind: "content", path: "src/deep/b.ts", line: 1, text: "padded needle" },
      ]);
    });
  });

  it("skips IGNORE_DIRS, lockfiles, .gitignore entries, protected and binary files", async () => {
    const ws = makeWorkspace();
    for (const dir of ["dist", "node_modules", ".git"]) {
      mkdirSync(join(ws, dir));
      writeFileSync(join(ws, dir, "hit.txt"), "needle in ignored dir");
    }
    writeFileSync(join(ws, "bun.lock"), "needle in lockfile");
    writeFileSync(join(ws, "ignored.txt"), "needle in gitignored");
    writeFileSync(join(ws, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(ws, ".env"), "needle=secret");
    writeFileSync(join(ws, "secret.key"), "needle in key");
    writeFileSync(join(ws, "blob.bin"), Buffer.from("needle\u0000binary", "utf8"));
    writeFileSync(join(ws, "tsconfig.tsbuildinfo"), '{"files":["needle"]}');
    writeFileSync(join(ws, "keep.txt"), "a needle here");
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "needle"))).json()) as SearchBody;
      expect(body.results.map((r) => r.path)).toEqual(["keep.txt"]);
    });
  });

  it("skips files larger than the per-file cap", async () => {
    const ws = makeWorkspace();
    const big = Buffer.alloc(MAX_SEARCH_FILE_BYTES + 1, 0x61);
    big.write("needle", 0, "utf8");
    writeFileSync(join(ws, "big.txt"), big);
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "needle"))).json()) as SearchBody;
      expect(body.results).toEqual([]);
      expect(body.scanned).toBe(0);
    });
  });

  it("caps results and reports truncated", async () => {
    const ws = makeWorkspace();
    const lines = Array.from({ length: MAX_SEARCH_RESULTS + 10 }, (_, i) => `needle ${i}`);
    writeFileSync(join(ws, "many.txt"), lines.join("\n"));
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "needle"))).json()) as SearchBody;
      expect(body.results.length).toBe(MAX_SEARCH_RESULTS);
      expect(body.truncated).toBe(true);
      expect(body.results[0].line).toBe(1);
      expect(body.results[MAX_SEARCH_RESULTS - 1].line).toBe(MAX_SEARCH_RESULTS);
    });
  });

  it("honours narrowed caps passed to searchWorkspace", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "a.txt"), "needle 1\nneedle 2\nneedle 3\n");
    const result = await searchWorkspace(ws, "needle", [], { maxResults: 2 });
    expect(result.results.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects empty and over-long queries", async () => {
    const ws = makeWorkspace();
    await withSearchApi(ws, async (base) => {
      const empty = await doFetch(`${base}/api/search?q=%20%20`);
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { error: string }).error).toBe("missing_query");

      const long = await doFetch(searchUrl(base, "a".repeat(MAX_SEARCH_QUERY + 1)));
      expect(long.status).toBe(400);
      const body = (await long.json()) as { error: string; limit: number };
      expect(body.error).toBe("query_too_long");
      expect(body.limit).toBe(MAX_SEARCH_QUERY);
    });
  });

  it("finds a file by name even when its content does not contain the query", async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "needle-name.ts"), "export const unrelated = 1;\n");
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "needle-name"))).json()) as SearchBody;
      expect(body.results).toEqual([{ kind: "path", path: "src/needle-name.ts" }]);
    });
  });

  it("puts name hits first and matches paths case-insensitively with either separator", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "a.txt"), "needle in body\n");
    writeFileSync(join(ws, "z-needle.txt"), "nothing here\n");
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "NEEDLE"))).json()) as SearchBody;
      expect(body.results).toEqual([
        { kind: "path", path: "z-needle.txt" },
        { kind: "content", path: "a.txt", line: 1, text: "needle in body" },
      ]);
      const windows = (await (await doFetch(searchUrl(base, ".\\Z-Needle"))).json()) as SearchBody;
      expect(windows.results).toEqual([{ kind: "path", path: "z-needle.txt" }]);
    });
  });

  it("finds large and binary files by name without reading them", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "needle.big"), Buffer.alloc(MAX_SEARCH_FILE_BYTES + 1, 0x61));
    writeFileSync(join(ws, "needle.bin"), Buffer.from("needle\u0000binary", "utf8"));
    writeFileSync(join(ws, "needle.ts"), "needle\n");
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "needle"))).json()) as SearchBody;
      expect(body.results).toEqual([
        { kind: "path", path: "needle.big" },
        { kind: "path", path: "needle.bin" },
        { kind: "path", path: "needle.ts" },
        { kind: "content", path: "needle.ts", line: 1, text: "needle" },
      ]);
    });
  });

  it("applies ignores and protected paths to name hits too", async () => {
    const ws = makeWorkspace();
    for (const dir of ["node_modules", "dist", ".git"]) mkdirSync(join(ws, dir));
    for (const rel of [
      "node_modules/vault.js",
      "dist/vault.txt",
      ".git/vault",
      "vault.key",
      ".env.vault",
    ]) {
      writeFileSync(join(ws, rel), "hidden");
    }
    writeFileSync(join(ws, ".gitignore"), "ignoredfile.txt\n");
    writeFileSync(join(ws, "ignoredfile.txt"), "hidden");
    writeFileSync(join(ws, "vault.txt"), "visible");
    await withSearchApi(ws, async (base) => {
      const body = (await (await doFetch(searchUrl(base, "vault"))).json()) as SearchBody;
      expect(body.results).toEqual([{ kind: "path", path: "vault.txt" }]);
    });
  });

  it("shares the result cap between name and content hits", async () => {
    const ws = makeWorkspace();
    for (let i = 0; i < 5; i++) writeFileSync(join(ws, `hit-${i}.txt`), "hit\n");
    const result = await searchWorkspace(ws, "hit-", [], { maxResults: 2 });
    expect(result.results).toEqual([
      { kind: "path", path: "hit-0.txt" },
      { kind: "path", path: "hit-1.txt" },
    ]);
    expect(result.truncated).toBe(true);
  });

  it("names=1 returns path hits only and does not read file contents", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "src-needle.ts"), "unrelated body\n");
    writeFileSync(join(ws, "body.txt"), "needle only in content\n");
    await withSearchApi(ws, async (base) => {
      const body = (await (
        await doFetch(searchUrl(base, "needle", "&names=1"))
      ).json()) as SearchBody;
      expect(body.results).toEqual([{ kind: "path", path: "src-needle.ts" }]);
      expect(body.scanned).toBe(0);
    });
  });

  it("answers 503 without a workspace", async () => {
    await withSearchApi(null, async (base) => {
      const res = await doFetch(searchUrl(base, "needle"));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("workspace_unavailable");
    });
  });

  it("ignores a path parameter: results can only come from the workspace", async () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, "inside.txt"), "needle");
    await withSearchApi(ws, async (base) => {
      for (const extra of ["&path=../", `&path=${encodeURIComponent(join(ws, ".."))}`]) {
        const res = await doFetch(searchUrl(base, "needle", extra));
        expect(res.status).toBe(200);
        const body = (await res.json()) as SearchBody;
        expect(body.results.map((r) => r.path)).toEqual(["inside.txt"]);
        for (const hit of body.results) {
          expect(hit.path.includes("..")).toBe(false);
          expect(hit.path.startsWith("/")).toBe(false);
        }
      }
    });
  });
});
