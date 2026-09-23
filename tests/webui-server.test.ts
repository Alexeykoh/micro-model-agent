import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { handleRequest, startServer, stopServer } from "../src/modules/webui/server";
import { BodyTooLargeError, readBody } from "../src/modules/webui/util";
import { createWebUiState } from "../src/modules/webui/state";
import type { Host } from "../src/core/host";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

function makeBridge(): Host {
  return {
    isBusy: () => false,
    submit: () => Promise.resolve(),
    interrupt: () => {},
    getState: () => ({ busy: false }),
    executeCommand: () => Promise.resolve(),
  };
}

// Other tests in the shared process may stub globalThis.fetch; use the runtime's
// own fetch so HTTP assertions stay real.
const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

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

/** Send a raw HTTP request over a socket (fetch forbids forging the Host header). */
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => sock.write(raw));
    let data = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      data += chunk;
    });
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      resolve(data);
    });
  });
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

  it("reports a submit rejection as error + state, never turn_end", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    const chunks: string[] = [];
    s.bridge = {
      isBusy: () => false,
      submit: () => Promise.reject(new Error("boom")),
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: () => Promise.resolve(),
    };
    // Test seam: broadcast only calls write/end; a full ServerResponse is overkill.
    const fake = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end: () => {},
    };
    s.clients.add(fake as unknown as ServerResponse);

    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(202);
      // Let the fire-and-forget rejection handler run.
      await new Promise((r) => setTimeout(r, 0));
    });

    const events = chunks.join("");
    expect(events).toContain("event: error");
    expect(events).toContain("boom");
    expect(events).toContain('"busy":false');
    expect(events).not.toContain("turn_end");
    expect(s.busy).toBe(false);
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

  it("requires a token on /events when one is configured", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      const denied = await get(base + "/events");
      expect(denied.status).toBe(401);

      const controller = new AbortController();
      const ok = await doFetch(base + "/events?token=s3cret", { signal: controller.signal });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("text/event-stream");
      controller.abort();
    });
  });

  it("delivers 413 for a body over the cap (before destroying the socket)", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.maxBodyBytes = 16;
    s.bridge = makeBridge();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(500) }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "body too large" });
    });
  });

  it("readBody rejects oversized payloads with the typed error", async () => {
    // Test seam: a real IncomingMessage is overkill for exercising the cap logic.
    const req = Readable.from([Buffer.alloc(64)]) as unknown as IncomingMessage;
    await expect(readBody(req, 16)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("does not crash on a malformed Host header", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const port = Number(new URL(base).port);
      const response = await rawRequest(
        port,
        "GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n",
      );
      expect(response).toContain("400");
    });
  });
});
