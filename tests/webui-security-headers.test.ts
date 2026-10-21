import { describe, it, expect } from "vitest";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch } from "./helpers/webui-server";

/**
 * Security-заголовки веб-поверхности и auth на статику (аудит §6.1/§6.2,
 * план `2026-10-12-harness-module-audit-fixes`, W6/Task 6.1).
 */

describe("webui: security-заголовки", () => {
  it("sends framing and content-type protection headers on the document", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const r = await doFetch(`${base}/`);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    });
  });

  it("static assets require auth on a token-protected bind", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      const denied = await doFetch(`${base}/app.js`);
      expect(denied.status).toBe(401);

      const allowed = await doFetch(`${base}/app.js?token=s3cret`);
      expect(allowed.status).toBe(200);
    });
  });

  it("the document requires auth too and hands out the auth cookie", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      const denied = await doFetch(`${base}/`);
      expect(denied.status).toBe(401);

      const allowed = await doFetch(`${base}/?token=s3cret`);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("set-cookie") || "").toContain("mma_web_auth=s3cret");
    });
  });

  it("keeps static open without a token (loopback dev)", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/app.js`);
      expect(res.status).toBe(200);
    });
  });
});
