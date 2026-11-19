/**
 * Ответы статики (INV-W1/W2, спека 2026-11-04-webui-latency-design, C1/C2).
 *
 * - неизвестный `.js` получает `404` и завершённый ответ: раньше ветка
 *   возвращала `true` без `res.end()` и запрос висел до таймаута браузера;
 * - `ETag` + `If-None-Match` дают `304` без тела: повторная загрузка страницы
 *   не тащит 174 файла заново.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetSource } from "../../src/modules/webui/asset-cache";
import { createWebUiState } from "../../src/modules/webui/state";
import { doFetch, webuiAssets, withServer } from "../helpers/webui-server";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("static assets", () => {
  it("answers 404 for an unknown JS module and always completes the response", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/js/does-not-exist.js`);
      expect(res.status).toBe(404);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({
        error: "not found",
      });
    });
  });

  it("revalidates with ETag and answers 304 with an empty body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-static-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
    const s = createWebUiState();
    const source = createAssetSource({ dir, ttlMs: 0, load: () => webuiAssets });
    s.assetSource = source.get;
    s.assetEtag = source.etag;

    await withServer(s, async (base) => {
      const first = await doFetch(`${base}/styles.css`);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-cache");
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^W\/"/);
      expect(await first.text()).toBe(webuiAssets.css);

      const second = await doFetch(`${base}/styles.css`, {
        headers: { "If-None-Match": String(etag) },
      });
      expect(second.status).toBe(304);
      expect(await second.text()).toBe("");
    });
  });
});
