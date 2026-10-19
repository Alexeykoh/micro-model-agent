import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import { DEFAULT_DATA_POLICY } from "../src/modules/security/data-policy/defaults";
import { createWebUiState } from "../src/modules/webui/state";
import { doFetch, withServer } from "./helpers/webui-server";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Workspace с публичным и скрытым каталогами. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-hidden-"));
  dirs.push(dir);
  mkdirSync(join(dir, "public"), { recursive: true });
  mkdirSync(join(dir, "secret"), { recursive: true });
  writeFileSync(join(dir, "public", "a.txt"), "ok", "utf-8");
  writeFileSync(join(dir, "secret", "b.txt"), "hidden", "utf-8");
  return dir;
}

function state(dir: string, over: Partial<typeof DEFAULT_DATA_POLICY> = {}) {
  const s = createWebUiState();
  s.workspace = dir;
  s.config = {
    security: { dataPolicy: { ...DEFAULT_DATA_POLICY, apiHiddenGlobs: ["secret/"], ...over } },
  } as unknown as AppConfig;
  return s;
}

describe("E2 web: apiHiddenGlobs (INV-D6)", () => {
  it("скрытый каталог не листается и не виден в родителе", async () => {
    const dir = workspace();
    const s = state(dir);
    await withServer(s, async (base) => {
      const root = (await (await doFetch(`${base}/api/files?path=.`)).json()) as {
        entries: Array<{ name: string }>;
      };
      expect(root.entries.map((e) => e.name)).toContain("public");
      expect(root.entries.map((e) => e.name)).not.toContain("secret");

      const hiddenDir = await doFetch(`${base}/api/files?path=secret`);
      expect(hiddenDir.status).toBe(404);

      const hiddenFile = await doFetch(`${base}/api/file?path=secret/b.txt`);
      expect(hiddenFile.status).toBe(404);
      expect(await hiddenFile.text()).not.toContain("hidden");

      const visible = await doFetch(`${base}/api/file?path=public/a.txt`);
      expect(visible.status).toBe(200);
      expect(await visible.text()).toBe("ok");
    });
  });

  it("канонизирует base: алиас workspace (symlink/junction) не ломает скрытие", async () => {
    const dir = workspace();
    const alias = `${dir}-alias`;
    symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const s = state(alias);
      await withServer(s, async (base) => {
        const root = (await (await doFetch(`${base}/api/files?path=.`)).json()) as {
          entries: Array<{ name: string }>;
        };
        expect(root.entries.map((e) => e.name)).toContain("public");
        expect(root.entries.map((e) => e.name)).not.toContain("secret");
        expect((await doFetch(`${base}/api/files?path=secret`)).status).toBe(404);
        expect((await doFetch(`${base}/api/file?path=secret/b.txt`)).status).toBe(404);
      });
    } finally {
      unlinkSync(alias);
    }
  });

  it("kill-switch: при enabled=false скрытых путей нет", async () => {
    const dir = workspace();
    const s = state(dir, { enabled: false });
    await withServer(s, async (base) => {
      const root = (await (await doFetch(`${base}/api/files?path=.`)).json()) as {
        entries: Array<{ name: string }>;
      };
      expect(root.entries.map((e) => e.name)).toContain("secret");
      const file = await doFetch(`${base}/api/file?path=secret/b.txt`);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("hidden");
    });
  });
});
