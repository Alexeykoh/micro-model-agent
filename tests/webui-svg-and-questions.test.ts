import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch, postJson } from "./helpers/webui-server";

/**
 * SVG отдаётся как неисполняемый текст, а закрытие сессии снимает висящий
 * вопрос (аудит §6.7/§6.8, план `2026-10-12-harness-module-audit-fixes`,
 * W6/Task 6.4).
 */

function stateWithSessionDir(dir: string, id = "S1"): ReturnType<typeof createWebUiState> {
  const s = createWebUiState();
  s.sessionManager = {
    list: () => [],
    get: (sid: string) => (sid === id ? ({ id: sid } as never) : null),
    getActive: () => id,
    setActive: () => {},
    delete: () => {},
    getSessionDirectory: () => dir,
  } as never;
  return s;
}

describe("webui: SVG и вопросы при закрытии", () => {
  it("never serves svg with an executable content type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-webui-svg-"));
    mkdirSync(join(dir, "images"), { recursive: true });
    writeFileSync(
      join(dir, "images", "shot.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "utf-8",
    );
    const s = stateWithSessionDir(dir);
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/sessions/S1/images/shot.svg`);
      expect(res.status).toBe(200);
      expect(["text/plain", "application/octet-stream"]).toContain(
        res.headers.get("content-type")?.split(";")[0],
      );
      expect(res.headers.get("content-disposition") || "").toContain("attachment");
    });
  });

  it("closing a session cancels the pending question server-side", async () => {
    const s = createWebUiState();
    let resolveQuestion: (() => void) | undefined;
    s.pendingQuestions.set("q1", {
      resolve: () => resolveQuestion?.(),
      sessionId: "S1",
    });
    s.sessionManager = {
      list: () => [],
      get: (sid: string) => ({ id: sid }) as never,
      getActive: () => "S1",
      setActive: () => {},
      delete: () => {},
    } as never;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/sessions/deactivate", {});
      expect(res.status).toBe(200);
      expect(s.pendingQuestions.size).toBe(0);
    });
  });
});
