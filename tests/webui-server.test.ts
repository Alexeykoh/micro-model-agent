import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { connect } from "node:net";
import { handleRequest, startServer, stopServer } from "../src/modules/webui/server";
import {
  BodyTooLargeError,
  MAX_IMAGE_DATA_URL_BYTES,
  parseMessageBody,
  readBody,
} from "../src/modules/webui/util";
import { drainQueueTurn, finishTurn } from "../src/modules/webui/turns";
import { MAX_QUEUE_LENGTH } from "../src/modules/webui/limits";
import { createWebUiState } from "../src/modules/webui/state";
import { makeForwarder } from "../src/modules/webui/forward";
import type { Host } from "../src/core/host";
import { withServer, doFetch, postJson, webuiAssets as assets } from "./helpers/webui-server";


function makeBridge(): Host {
  return {
    isBusy: () => false,
    submit: () => Promise.resolve(),
    interrupt: () => {},
    getState: () => ({ busy: false }),
    executeCommand: () => Promise.resolve(),
  };
}

function get(url: string): Promise<{ status: number; body: string }> {
  return doFetch(url).then(async (r) => ({ status: r.status, body: await r.text() }));
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
    const page = await get(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("hi");
    const js = await get(`${url}/app.js`);
    expect(js.body).toBe("//ok");
  });

  it("404s unknown paths", async () => {
    const url = await startServer(assets);
    expect((await get(`${url}/nope`)).status).toBe(404);
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
      const res = await doFetch(`${base}/api/message`, {
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
      const res = await postJson(base, "/api/message", { text: "hi" });
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

  it("does not double-report a failed turn: the forwarder's turn_end owns the error", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    const fwd = makeForwarder(s); // default sink broadcasts to s.clients
    const chunks: string[] = [];
    const fake = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end: () => {},
    };
    s.clients.add(fake as unknown as ServerResponse);
    s.bridge = {
      isBusy: () => s.agentRunning,
      // Realistic failed turn: the agent's catch emits turn_end {success:false}
      // (which clears the reservation) and THEN rethrows.
      submit: () => {
        fwd.onTurnEnd({ success: false });
        return Promise.reject(new Error("boom"));
      },
      interrupt: () => {},
      getState: () => ({ busy: s.busy }),
      executeCommand: () => Promise.resolve(),
    };

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/message", { text: "hi" });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 0));
    });

    const events = chunks.join("");
    expect(events).toContain("event: turn_end");
    expect(events).not.toContain("event: error");
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
      const bad = await doFetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "invalid JSON" });

      const empty = await doFetch(`${base}/api/message`, {
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
      const denied = await get(`${base}/events`);
      expect(denied.status).toBe(401);

      const controller = new AbortController();
      const ok = await doFetch(`${base}/events?token=s3cret`, { signal: controller.signal });
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
      const res = await doFetch(`${base}/api/message`, {
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

  it("queues mid-turn POSTs and drains them in order after turn_end", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    let release: (() => void) | null = null;
    const started: string[] = [];
    const bridge: Host = {
      isBusy: () => s.agentRunning,
      submit: (text) => {
        started.push(text);
        return new Promise<void>((r) => {
          release = r;
        });
      },
      interrupt: () => {},
      getState: () => ({ busy: s.busy }),
      executeCommand: () => Promise.resolve(),
    };
    s.bridge = bridge;
    // Production wiring (module.ts): the forwarder drains the queue on turn_end.
    const fwd = makeForwarder(s, () => {}, { onQueueDrained: () => drainQueueTurn(s) });

    await withServer(s, async (base) => {
      const post = (text: string) =>
        doFetch(`${base}/api/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });

      // First POST starts the turn immediately.
      const a = await post("first");
      expect(a.status).toBe(202);
      expect(await a.json()).toEqual({ ok: true, sessionId: null });
      expect(started).toEqual(["first"]);
      expect(s.busy).toBe(true);

      // Mid-turn POSTs queue instead of 409 (the old contract).
      const b = await post("second");
      expect(b.status).toBe(202);
      expect(await b.json()).toEqual({ ok: true, queued: 1, sessionId: null, queuedForSession: 1 });
      expect(started).toHaveLength(1);
      expect(s.pool.queueLen(null)).toBe(1);

      const state = await (await doFetch(`${base}/api/state`)).json();
      expect(state.queueLen).toBe(1);

      // turn_end drains the head as the next turn (same tick, still ordered).
      release?.();
      await new Promise((r) => setTimeout(r, 0));
      fwd.onTurnEnd({ success: true });
      expect(started).toEqual(["first", "second"]);
      expect(s.busy).toBe(true);
      expect(s.pool.queueLen(null)).toBe(0);

      // Drained turn ends: the slot is free again.
      release?.();
      await new Promise((r) => setTimeout(r, 0));
      fwd.onTurnEnd({ success: true });
      expect(s.busy).toBe(false);

      const c = await post("third");
      expect(c.status).toBe(202);
      expect(await c.json()).toEqual({ ok: true, sessionId: null });
      expect(started).toEqual(["first", "second", "third"]);
    });
  });

  it("rejects past the queue cap with 429 queue_full", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.bridge = {
      isBusy: () => true, // turn never ends: everything queues
      submit: () => Promise.resolve(),
      interrupt: () => {},
      getState: () => ({ busy: s.busy }),
      executeCommand: () => Promise.resolve(),
    };

    await withServer(s, async (base) => {
      const post = (text: string) =>
        doFetch(`${base}/api/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      // First POST always starts immediately (slot was free); the rest queue
      // behind the never-ending turn until the cap, then 429.
      const first = await post("q-first");
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ ok: true, sessionId: null });
      for (let i = 0; i < MAX_QUEUE_LENGTH; i++) {
        const r = await post(`q${i}`);
        expect(r.status).toBe(202);
        expect(await r.json()).toEqual({ ok: true, queued: i + 1, sessionId: null, queuedForSession: i + 1 });
      }
      const full = await post("overflow");
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({ error: "queue_full" });
      expect(s.pool.queueLen(null)).toBe(MAX_QUEUE_LENGTH);
    });
  });

  it("drainQueueTurn is a no-op without bridge, while busy, or when empty", () => {
    const s = createWebUiState();
    s.pool.enqueue(null, "x", [], null);
    expect(drainQueueTurn(s)).toBe(false); // no bridge: entry kept
    expect(s.pool.queueLen(null)).toBe(1);

    s.bridge = makeBridge();
    s.busy = true;
    expect(drainQueueTurn(s)).toBe(false);
    s.busy = false;
    s.pool.shift(null);
    expect(drainQueueTurn(s)).toBe(false);
  });

  it("routes each POST to its own session and switches on drain", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    let active = "A";
    s.sessionManager = {
      list: () => [],
      get: (id: string) => (id === "A" || id === "B" ? { id } : null) as never,
      getActive: () => active,
      setActive: (id: string) => {
        active = id;
      },
      delete: () => {},
    };
    let release: (() => void) | null = null;
    const started: string[] = [];
    s.bridge = {
      isBusy: () => s.agentRunning,
      submit: (text) => {
        started.push(text as string);
        return new Promise<void>((r) => {
          release = r;
        });
      },
      interrupt: () => {},
      getState: () => ({ busy: s.busy }),
      executeCommand: () => Promise.resolve(),
    };
    const ownerRef = { current: null as string | null };
    const fwd = makeForwarder(s, () => {}, {
      onQueueDrained: (owner) => finishTurn(s, owner),
      ownerRef,
    });

    await withServer(s, async (base) => {
      const post = (text: string, sessionId?: string) =>
        doFetch(`${base}/api/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionId ? { text, sessionId } : { text }),
        });

      // Idle POST from tab B runs in B even though A was active.
      // (Legacy: shared bridge, so the test stamps the owner like run-agent.)
      ownerRef.current = "B";
      const first = await post("from-b", "B");
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ ok: true, sessionId: "B" });
      expect(active).toBe("B");
      expect(s.pool.isBusy("B")).toBe(true);

      // Mid-turn POST from tab A queues under A, not B.
      const second = await post("for-a", "A");
      expect(second.status).toBe(202);
      expect(await second.json()).toEqual({ ok: true, queued: 1, sessionId: "A", queuedForSession: 1 });

      const state = await (await doFetch(`${base}/api/state`)).json();
      expect(state.runningSessionIds).toEqual(["B"]);
      expect(state.runningSessionId).toBe("B");
      expect(state.queued).toEqual({ A: 1 });

      // turn_end drains A next and switches back to it.
      release?.();
      await new Promise((r) => setTimeout(r, 0));
      fwd.onTurnEnd({ success: true });
      expect(started).toEqual(["from-b", "for-a"]);
      expect(active).toBe("A");
      expect(s.pool.isBusy("A")).toBe(true);
    });
  });

  it("rejects a message for an unknown session with 404", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.sessionManager = {
      list: () => [],
      get: () => null,
      getActive: () => "A",
      setActive: () => {},
      delete: () => {},
    };
    s.bridge = makeBridge();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", sessionId: "nope" }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(s.busy).toBe(false);
    });
  });

  it("interrupt with a foreign sessionId leaves someone else's turn alone", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    let release: (() => void) | null = null;
    let interrupted = 0;
    s.bridge = {
      isBusy: () => s.agentRunning,
      submit: () =>
        new Promise<void>((r) => {
          release = r;
        }),
      interrupt: () => {
        interrupted++;
      },
      getState: () => ({ busy: s.busy }),
      executeCommand: () => Promise.resolve(),
    };
    const fwd = makeForwarder(s, () => {});
    await withServer(s, async (base) => {
      const stop = (sessionId?: string) =>
        doFetch(`${base}/api/interrupt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionId ? { sessionId } : {}),
        });
      const started = await doFetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(started.status).toBe(202);
      // Idle POST above has no session target (legacy "" slot); a foreign
      // stop must not touch it.
      const foreign = await stop("B");
      expect(foreign.status).toBe(409);
      expect(interrupted).toBe(0);
      expect(s.busy).toBe(true);

      const own = await stop();
      expect(own.status).toBe(200);
      expect(interrupted).toBe(1);

      release?.();
      fwd.onTurnEnd({ success: true });
      expect(s.busy).toBe(false);
    });
  });

  it("refuses to delete a running or queued session", async () => {
    const s = createWebUiState();
    const alive = new Set(["A", "B"]);
    s.sessionManager = {
      list: () => [],
      get: (id: string) => (alive.has(id) ? { id } : null) as never,
      getActive: () => "A",
      setActive: () => {},
      delete: (id: string) => {
        alive.delete(id);
      },
    };
    s.pool.reserve("B");
    s.pool.enqueue("B", "q", [], "B");
    await withServer(s, async (base) => {
      const del = await doFetch(`${base}/api/sessions/B`, { method: "DELETE" });
      expect(del.status).toBe(409);
      expect(await del.json()).toEqual({ error: "session_busy" });
      expect(alive.has("B")).toBe(true);
    });
  });

  it("interrupt does not clear busy; the turn_end reset owns it", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    let release: (() => void) | null = null;
    let interrupted = 0;
    const bridge: Host = {
      isBusy: () => s.agentRunning,
      submit: () =>
        new Promise<void>((r) => {
          release = r;
        }),
      interrupt: () => {
        interrupted++;
      },
      getState: () => ({ busy: s.busy }),
      executeCommand: () => Promise.resolve(),
    };
    s.bridge = bridge;
    const fwd = makeForwarder(s, () => {});

    await withServer(s, async (base) => {
      const started = await doFetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(started.status).toBe(202);
      expect(s.busy).toBe(true);

      const res = await doFetch(`${base}/api/interrupt`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(interrupted).toBe(1);
      // The aborted turn is still unwinding: busy must NOT be cleared here.
      expect(s.busy).toBe(true);

      release?.();
      fwd.onTurnEnd({ success: true, interrupted: true });
      expect(s.busy).toBe(false);
    });
  });

  it("interrupt returns 409 when idle", async () => {
    const s = createWebUiState();
    s.bridge = makeBridge();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/interrupt`, { method: "POST" });
      expect(res.status).toBe(409);
    });
  });

  it("POST /api/index triggers refreshIndex and returns 202", async () => {
    const s = createWebUiState();
    let called = 0;
    s.refreshIndex = async () => {
      called += 1;
    };
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/index");
      expect(r.status).toBe(202);
    });
    expect(called).toBe(1);
  });

  it("POST /api/index returns 503 when no refreshIndex is wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/index");
      expect(r.status).toBe(503);
    });
  });

  it("POST /api/index returns 202 even if refreshIndex rejects", async () => {
    const s = createWebUiState();
    s.refreshIndex = async () => {
      throw new Error("boom");
    };
    await withServer(s, async (base) => {
      const r = await postJson(base, "/api/index");
      expect(r.status).toBe(202);
    });
  });
});

describe("webui message body validation", () => {
  const img = (n = 16) => `data:image/png;base64,${"A".repeat(n)}`;

  it("accepts up to 3 data-url images", () => {
    const body = parseMessageBody(JSON.stringify({ text: "hi", images: [img(), img(), img()] }));
    expect(body).toEqual({ text: "hi", images: [img(), img(), img()] });
  });

  it("rejects more than 3 images", () => {
    const body = parseMessageBody(
      JSON.stringify({ text: "hi", images: [img(), img(), img(), img()] }),
    );
    expect(body).toEqual({ error: "too many images" });
  });

  it("rejects a non-data-url image", () => {
    const body = parseMessageBody(JSON.stringify({ text: "hi", images: ["http://x/y.png"] }));
    expect(body).toEqual({ error: "invalid image" });
  });

  it("rejects an oversized image", () => {
    const big = `data:image/png;base64,${"A".repeat(MAX_IMAGE_DATA_URL_BYTES)}`;
    const body = parseMessageBody(JSON.stringify({ text: "hi", images: [big] }));
    expect(body).toEqual({ error: "image too large" });
  });
});

describe("webui parallel sessions (runner factory)", () => {
  /** Стаб раннера: управляемые deferred-ходы, счётчики стартов/стопов. */
  function stubRunnerPool() {
    const stubs = new Map<
      string,
      {
        started: string[];
        shutdowns: number;
        images: unknown[];
        resolvers: Array<(v: unknown) => void>;
        chunks: Array<(chunk: string) => void>;
      }
    >();
    const stub = (id: string) => {
      let entry = stubs.get(id);
      if (!entry) {
        entry = { started: [], shutdowns: 0, images: [], resolvers: [], chunks: [] };
        stubs.set(id, entry);
      }
      return entry;
    };
    const factory = (id: string) =>
      ({
        sessionId: id,
        agent: {
          run: (text: string, onChunk?: (chunk: string) => void) => {
            const entry = stub(id);
            entry.started.push(text);
            if (onChunk) entry.chunks.push(onChunk);
            return new Promise<unknown>((resolve) => {
              entry.resolvers.push(resolve);
            });
          },
          shutdown: () => {
            stub(id).shutdowns++;
          },
        },
        contextManager: {
          addPendingImage: (part: unknown) => {
            stub(id).images.push(part);
          },
        },
        execModule: { getActivePlan: () => null },
      }) as never;
    return { stubs, stub, factory };
  }

  function sessionStub(ids: string[]) {
    const alive = new Set(ids);
    return {
      list: () => [],
      get: (id: string) => (alive.has(id) ? { id } : null) as never,
      getActive: () => ids[0] ?? null,
      setActive: () => {},
      delete: (id: string) => {
        alive.delete(id);
      },
    };
  }

  const postMsg = (base: string, text: string, sessionId?: string, images?: string[]) =>
    doFetch(`${base}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        Object.assign(
          { text },
          sessionId ? { sessionId } : {},
          images ? { images } : {},
        ),
      ),
    });

  it("runs two sessions concurrently with own streams and serial order within", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.sessionManager = sessionStub(["A", "B"]);
    const { stubs, stub, factory } = stubRunnerPool();
    s.pool.setFactory(factory);
    // Ловим SSE, чтобы проверить per-tab роутинг событий параллельных ходов.
    const chunks: string[] = [];
    s.clients.add({
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end: () => {},
    } as unknown as ServerResponse);

    await withServer(s, async (base) => {
      const a = await postMsg(base, "task-a", "A");
      expect(a.status).toBe(202);
      const b = await postMsg(base, "task-b", "B");
      expect(b.status).toBe(202);
      // Оба хода стартовали, ни один не ждёт другого.
      expect(stub("A").started).toEqual(["task-a"]);
      expect(stub("B").started).toEqual(["task-b"]);
      expect(s.pool.isBusy("A")).toBe(true);
      expect(s.pool.isBusy("B")).toBe(true);
      const state = await (await doFetch(`${base}/api/state`)).json();
      expect(new Set(state.runningSessionIds)).toEqual(new Set(["A", "B"]));

      // Стрим чанка A ложится только во вкладку A.
      stub("A").chunks[0]?.("hello-a");
      await new Promise((r) => setTimeout(r, 500));
      const texts = chunks.join("");
      expect(texts).toContain("hello-a");
      expect(texts).toContain('"sessionId":"A"');

      // Второе сообщение в занятую A встаёт в её очередь (B не трогаем).
      const a2 = await postMsg(base, "task-a2", "A");
      expect(a2.status).toBe(202);
      expect(await a2.json()).toEqual({ ok: true, queued: 1, sessionId: "A", queuedForSession: 1 });
      expect(stub("A").started).toEqual(["task-a"]);

      // Конец хода A: turn_end за A, дренаж её очереди, B всё ещё бежит.
      stub("A").resolvers.shift()?.({ success: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(stub("A").started).toEqual(["task-a", "task-a2"]);
      expect(s.pool.isBusy("B")).toBe(true);
      const ends = chunks.join("").match(/"sessionId":"A"/g) ?? [];
      expect(ends.length).toBeGreaterThan(0);

      // Конец хода B и второго хода A: всё свободно.
      stub("B").resolvers.shift()?.({ success: true });
      stub("A").resolvers.shift()?.({ success: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(s.pool.anyBusy()).toBe(false);
      expect(s.busy).toBe(false);
    });
  });

  it("delivers images into the owning runner context", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.sessionManager = sessionStub(["A"]);
    const { stub, factory } = stubRunnerPool();
    s.pool.setFactory(factory);

    await withServer(s, async (base) => {
      const img = "data:image/png;base64,AAAA";
      const r = await postMsg(base, "look", "A", [img]);
      expect(r.status).toBe(202);
      expect(stub("A").images).toHaveLength(1);
      stub("A").resolvers.shift()?.({ success: true });
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  it("interrupts only the targeted session runner", async () => {
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.sessionManager = sessionStub(["A", "B"]);
    const { stub, factory } = stubRunnerPool();
    s.pool.setFactory(factory);

    await withServer(s, async (base) => {
      await postMsg(base, "task-a", "A");
      await postMsg(base, "task-b", "B");
      const stop = await doFetch(`${base}/api/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "B" }),
      });
      expect(stop.status).toBe(200);
      expect(stub("B").shutdowns).toBe(1);
      expect(stub("A").shutdowns).toBe(0);
      expect(s.pool.isBusy("A")).toBe(true);
      stub("A").resolvers.shift()?.({ success: true });
      stub("B").resolvers.shift()?.({ success: true });
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});
