import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";
import { requestError, BodyTooLargeError } from "../src/modules/webui/util";
import { withServer, doFetch } from "./helpers/webui-server";

/**
 * Ошибки запроса не подменяются на «400 bad request» (аудит §6.6, план
 * `2026-10-12-harness-module-audit-fixes`, W6/Task 6.3): таймаут — 504,
 * серверный сбой — 500, битый JSON — 400, переполнение — 413.
 */

describe("webui: маппинг ошибок запроса", () => {
  it("a server-side failure surfaces as 500, not 400", async () => {
    const s = createWebUiState();
    s.memory = {
      append: () => {
        throw new Error("disk on fire");
      },
      list: () => [],
      clear: () => {},
      remove: () => {},
    } as never;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "facts", text: "hello" }),
      });
      expect(res.status).toBe(500);
      expect(res.status).not.toBe(400);
    });
  });

  it("maps a broken JSON body to 400", async () => {
    const s = createWebUiState();
    s.config = { locale: "en" } as never;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });

  it("maps an oversized body to 413", async () => {
    const s = createWebUiState();
    s.config = { locale: "en" } as never;
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(2 * 1024 * 1024),
      });
      expect(res.status).toBe(413);
    });
  });

  it("requestError maps a generic failure to 500 with a scrubbed detail", async () => {
    const srv = createServer((req, res) => {
      requestError(req, res, new Error("boom: API_KEY=supersecretvalue12345"));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/x`);
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain("supersecretvalue12345");
      expect(body).toContain("internal error");
    } finally {
      srv.close();
    }
  });

  it("requestError maps a timeout to 504", async () => {
    const srv = createServer((req, res) => {
      const err = Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "AbortError",
      });
      requestError(req, res, err);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/x`);
      expect(res.status).toBe(504);
    } finally {
      srv.close();
    }
  });

  it("requestError maps BodyTooLargeError to 413", async () => {
    const srv = createServer((req, res) => {
      requestError(req, res, new BodyTooLargeError());
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await doFetch(`http://127.0.0.1:${port}/x`);
      expect(res.status).toBe(413);
    } finally {
      srv.close();
    }
  });
});
