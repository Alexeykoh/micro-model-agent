import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createWebUiState } from "../src/modules/webui/state";
import { saveToolImage } from "../src/modules/session/image-store";
import { withServer, doFetch } from "./helpers/webui-server";

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Stub менеджера поверх реального temp-каталога (как в webui-log.test.ts). */
function managerWith(dir: string) {
  return {
    get: (id: string) => (id === "s1" ? { id } : undefined),
    getSessionDirectory: (id: string) => join(dir, id),
  };
}

describe("GET /api/sessions/:id/images/:name", () => {
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-simg-"));
    sessionId = "s1";
    const dir = join(tmpDir, sessionId);
    mkdirSync(dir, { recursive: true });
    saveToolImage(dir, { bytes: PNG_BYTES, mime: "image/png" }, { maxCount: 30, maxBytes: 1e9 });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function state() {
    const s = createWebUiState();
    s.sessionManager = managerWith(tmpDir) as unknown as typeof s.sessionManager;
    return s;
  }

  function storedFile(): string {
    // Первый (и единственный) файл в `<session>/images`.
    return readdirSync(join(tmpDir, sessionId, "images"))[0] as string;
  }

  it("serves the image bytes with mime and immutable cache", async () => {
    await withServer(state(), async (base) => {
      const res = await doFetch(`${base}/api/sessions/${sessionId}/images/${storedFile()}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("immutable");
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
    });
  });

  it("404s for an unknown session", async () => {
    await withServer(state(), async (base) => {
      const res = await doFetch(`${base}/api/sessions/nope/images/x.png`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });
  });

  it("404s for a missing file (rotated away)", async () => {
    await withServer(state(), async (base) => {
      const res = await doFetch(`${base}/api/sessions/${sessionId}/images/gone.png`);
      expect(res.status).toBe(404);
    });
  });

  it("404s traversal attempts instead of escaping the jail", async () => {
    await withServer(state(), async (base) => {
      for (const evil of ["..%2F..%2Fmeta.json", "%2E%2E%2Fimages", "..%5Cx.png"]) {
        const res = await doFetch(`${base}/api/sessions/${sessionId}/images/${evil}`);
        expect(res.status, evil).toBe(404);
      }
      expect(existsSync(join(tmpDir, sessionId, "meta.json"))).toBe(false);
    });
  });

  it("treats a file outside the images dir as missing", async () => {
    writeFileSync(join(tmpDir, sessionId, "secret.txt"), "hi");
    await withServer(state(), async (base) => {
      const res = await doFetch(`${base}/api/sessions/${sessionId}/images/secret.txt`);
      // Имя валидно, но файла в `images/` нет.
      expect(res.status).toBe(404);
    });
  });
});
