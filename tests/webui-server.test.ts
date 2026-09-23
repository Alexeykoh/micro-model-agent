import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { handleRequest, startServer, stopServer } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";
import type { Host } from "../src/core/host";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

// Other tests in the shared process may stub globalThis.fetch; use the runtime's
// own fetch so HTTP assertions stay real.
const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? ((Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun)) : fetch;

function get(url: string): Promise<{ status: number; body: string }> {
  return doFetch(url).then(async (r) => ({ status: r.status, body: await r.text() }));
}

async function withServer(
  s: ReturnType<typeof createWebUiState>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
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

describe("webui server", () => {
  afterEach(() => stopServer());

  it("serves static assets", async () => {
    const url = await startServer(assets);
    const page = await get(url + "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("hi");
    const js = await get(url + "/app.js");
    expect(js.body).toBe("//ok");
  });

  it("404s unknown paths", async () => {
    const url = await startServer(assets);
    expect((await get(url + "/nope")).status).toBe(404);
  });

  it("handleRequest works against an explicit state (app≠listen)", async () => {
    const s = createWebUiState();
    const srv = createServer((req, res) => handleRequest(req, res, assets, s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    srv.close();
  });

  it("caps the message text at 32K before submitting", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    const submitted: string[] = [];
    const bridge: Host = {
      isBusy: () => false,
      submit: (text) => {
        submitted.push(text);
        return Promise.resolve();
      },
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: () => Promise.resolve(),
    };
    s.bridge = bridge;

    await withServer(s, async (base) => {
      const long = "a".repeat(40_000);
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: long }),
      });
      expect(res.status).toBe(202);
      expect(submitted).toHaveLength(1);
      expect(submitted[0].length).toBeLessThanOrEqual(32768);
    });
  });

  it("distinguishes invalid JSON from an empty message", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    const bridge: Host = {
      isBusy: () => false,
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: () => Promise.resolve(),
    };
    s.bridge = bridge;

    await withServer(s, async (base) => {
      const bad = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "invalid JSON" });

      const empty = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: "empty" });
    });
  });
});
