import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { handleRequest, stopServer } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";
import { checkAuth } from "../src/modules/webui/util";
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

describe("webui auth + limits", () => {
  afterEach(() => stopServer());

  it("401 without a token on /api/state and /api/command; 200/202 via header or ?token=", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    s.bridge = makeBridge();
    await withServer(s, async (base) => {
      const stateDenied = await doFetch(base + "/api/state");
      expect(stateDenied.status).toBe(401);

      const cmdDenied = await doFetch(base + "/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: "/status" }),
      });
      expect(cmdDenied.status).toBe(401);

      const stateHeader = await doFetch(base + "/api/state", {
        headers: { "x-mma-token": "s3cret" },
      });
      expect(stateHeader.status).toBe(200);

      const stateQuery = await doFetch(base + "/api/state?token=s3cret");
      expect(stateQuery.status).toBe(200);

      const cmdHeader = await doFetch(base + "/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mma-token": "s3cret" },
        body: JSON.stringify({ line: "/status" }),
      });
      expect(cmdHeader.status).toBe(202);
    });
  });

  it("403 on a cross-origin POST to /api/message", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.bridge = makeBridge();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross-origin requests are not allowed" });
    });
  });

  it("503 on /api/message when no bridge is set", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.bridge = null;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "no_bridge" });
    });
  });

  it("409 on /api/message when already busy", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.bridge = makeBridge();
    s.busy = true;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "busy" });
    });
  });

  it("429 on a second /api/message within minPostIntervalMs", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 60_000;
    s.bridge = makeBridge();
    s.lastPostTs = Date.now();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "rate_limited" });
    });
  });

  it("503 on /events once the client cap is reached", async () => {
    const s = createWebUiState();
    const controllers: AbortController[] = [];
    await withServer(s, async (base) => {
      // MAX_CLIENTS defaults to 5; hold that many streams open, then the next is capped.
      for (let i = 0; i < 5; i++) {
        const controller = new AbortController();
        const ok = await doFetch(base + "/events", { signal: controller.signal });
        expect(ok.status).toBe(200);
        controllers.push(controller);
      }
      // Give the server a tick to register all clients.
      await new Promise((r) => setTimeout(r, 0));
      const capped = await doFetch(base + "/events");
      expect(capped.status).toBe(503);
      expect(await capped.json()).toEqual({ error: "too many clients" });
    });
    for (const c of controllers) c.abort();
  });

  it("202 on /api/command with a valid token and dispatches the line to the bridge", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    const lines: string[] = [];
    const bridge: Host = {
      isBusy: () => false,
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: false }),
      executeCommand: (line) => {
        lines.push(line);
        return Promise.resolve();
      },
    };
    s.bridge = bridge;
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/command?token=s3cret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: "/status" }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
      // executeCommand is fire-and-forget; let the microtask run.
      await new Promise((r) => setTimeout(r, 0));
      expect(lines).toEqual(["/status"]);
    });
  });

  it("checkAuth accepts the mma_web_auth cookie when a token is configured", () => {
    const s = createWebUiState();
    s.token = "s3cret";
    const req = { headers: { cookie: "other=1; mma_web_auth=s3cret" } } as unknown as IncomingMessage;
    expect(checkAuth(req, new URL("http://127.0.0.1/api/state"), s)).toBe(true);
    const bad = { headers: { cookie: "mma_web_auth=nope" } } as unknown as IncomingMessage;
    expect(checkAuth(bad, new URL("http://127.0.0.1/api/state"), s)).toBe(false);
  });

  it("sets the auth cookie on an authenticated api response", async () => {
    const s = createWebUiState();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/i18n", { headers: { "x-mma-token": "s3cret" } });
      expect(res.headers.get("set-cookie") || "").toContain("mma_web_auth=s3cret");
    });
  });
});
