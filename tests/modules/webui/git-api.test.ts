import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebUiState } from "../../../src/modules/webui/state";
import { withServer, doFetch } from "../../helpers/webui-server";

/**
 * Git-роуты веба (спека git-workflow §6.1): **только чтение**.
 * Проверяем то, что обещано контрактом: пишущих методов нет, вне репозитория
 * честный `repo:false` (не ошибка), путь диффа не выходит за workspace и не
 * отдаёт защищённые файлы, кап ответа соблюдается.
 */

const tmpRoots: string[] = [];

function gitIn(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-webui-git-"));
  tmpRoots.push(dir);
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, ["config", "user.email", "t@example.com"]);
  gitIn(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  gitIn(dir, ["add", "a.txt"]);
  gitIn(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function withGitApi(ws: string, check: (base: string) => Promise<void>): Promise<void> {
  const s = createWebUiState();
  s.workspace = ws;
  await withServer(s, check);
}

describe("webui git api", () => {
  afterEach(() => {
    while (tmpRoots.length) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
  });

  it("returns a snapshot for a real repository", async () => {
    const ws = makeRepo();
    await withGitApi(ws, async (base) => {
      const res = await doFetch(`${base}/api/git`, { headers: {} });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { repo: boolean; branch?: string; dirty?: number };
      expect(body.repo).toBe(true);
      expect(body.dirty).toBe(0);
      expect(typeof body.branch).toBe("string");
    });
  });

  it("answers repo:false (200) outside a repository instead of an error", async () => {
    const plain = mkdtempSync(join(tmpdir(), "mma-webui-nogit-"));
    tmpRoots.push(plain);
    await withGitApi(plain, async (base) => {
      const res = await doFetch(`${base}/api/git`, { headers: {} });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { repo: boolean }).repo).toBe(false);
    });
  });

  it("lists changed files in /api/git/changes", async () => {
    const ws = makeRepo();
    writeFileSync(join(ws, "a.txt"), "two\n");
    writeFileSync(join(ws, "new.txt"), "fresh\n");
    await withGitApi(ws, async (base) => {
      const body = (await (await doFetch(`${base}/api/git/changes`, { headers: {} })).json()) as {
        repo: boolean;
        files: { path: string; worktree: string }[];
      };
      expect(body.repo).toBe(true);
      expect(body.files.map((f) => f.path).sort()).toEqual(["a.txt", "new.txt"]);
    });
  });

  it("serves a diff for a modified file", async () => {
    const ws = makeRepo();
    writeFileSync(join(ws, "a.txt"), "two\n");
    await withGitApi(ws, async (base) => {
      const url = `${base}/api/git/diff?path=${encodeURIComponent("a.txt")}`;
      const body = (await (await doFetch(url, { headers: {} })).json()) as {
        diff: string;
        truncated: boolean;
      };
      expect(body.diff).toContain("-one");
      expect(body.diff).toContain("+two");
      expect(body.truncated).toBe(false);
    });
  });

  it("flags an untracked file instead of returning an empty answer", async () => {
    const ws = makeRepo();
    writeFileSync(join(ws, "fresh.txt"), "new\n");
    await withGitApi(ws, async (base) => {
      const url = `${base}/api/git/diff?path=${encodeURIComponent("fresh.txt")}`;
      const body = (await (await doFetch(url, { headers: {} })).json()) as { untracked?: boolean };
      expect(body.untracked).toBe(true);
    });
  });

  it("refuses a path outside the workspace", async () => {
    const ws = makeRepo();
    await withGitApi(ws, async (base) => {
      const url = `${base}/api/git/diff?path=${encodeURIComponent("../../etc/passwd")}`;
      const res = await doFetch(url, { headers: {} });
      expect([403, 404]).toContain(res.status);
    });
  });

  it("refuses a protected file (.env) even inside the workspace", async () => {
    const ws = makeRepo();
    writeFileSync(join(ws, ".env"), "SECRET=1\n");
    await withGitApi(ws, async (base) => {
      const url = `${base}/api/git/diff?path=${encodeURIComponent(".env")}`;
      const res = await doFetch(url, { headers: {} });
      expect([403, 404]).toContain(res.status);
    });
  });

  it("has no writing git route (POST is rejected)", async () => {
    const ws = makeRepo();
    await withGitApi(ws, async (base) => {
      const res = await doFetch(`${base}/api/git/changes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(405);
    });
  });
});
