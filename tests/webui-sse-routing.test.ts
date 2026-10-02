import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { createWebUiState, broadcast } from "../src/modules/webui/state";

/** Minimal SSE client: broadcast only calls `write`/`end`. */
function fakeClient(chunks: string[]): ServerResponse {
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {},
  } as unknown as ServerResponse;
}

describe("webui per-session SSE routing", () => {
  it("delivers a session event only to subscribers of that session", () => {
    const s = createWebUiState();
    const a: string[] = [];
    const b: string[] = [];
    const any: string[] = [];
    const ca = fakeClient(a);
    const cb = fakeClient(b);
    const cn = fakeClient(any);
    s.clients.add(ca);
    s.clientSessions.set(ca, "A");
    s.clients.add(cb);
    s.clientSessions.set(cb, "B");
    s.clients.add(cn); // legacy client without a subscription

    broadcast({ type: "text", ts: 1, sessionId: "A", chunk: "hi" }, s);
    expect(a.join("")).toContain("hi");
    expect(b.join("")).not.toContain("hi");
    expect(any.join("")).toContain("hi");
  });

  it("delivers global events (no sessionId) to everyone", () => {
    const s = createWebUiState();
    const a: string[] = [];
    const b: string[] = [];
    const ca = fakeClient(a);
    const cb = fakeClient(b);
    s.clients.add(ca);
    s.clientSessions.set(ca, "A");
    s.clients.add(cb);
    s.clientSessions.set(cb, "B");

    broadcast({ type: "state", ts: 1, busy: true }, s);
    expect(a.join("")).toContain('"busy":true');
    expect(b.join("")).toContain('"busy":true');
  });

  it("does not auto-stamp activeSessionId onto global events", () => {
    const s = createWebUiState();
    s.activeSessionId = "A";
    const chunks: string[] = [];
    const c = fakeClient(chunks);
    s.clients.add(c);

    broadcast({ type: "state", ts: 1, busy: false }, s);
    expect(chunks.join("")).not.toContain('"sessionId":"A"');
  });
});

describe("webui SSE end-to-end (subscription)", () => {
  it("a client subscribed to A receives A's runner stream over /events", async () => {
    const { withServer, doFetch, postJson } = await import("./helpers/webui-server");
    const s = createWebUiState();
    s.minPostIntervalMs = 0;
    s.sessionManager = {
      list: () => [],
      get: (id: string) => ({ id }) as never,
      getActive: () => "A",
      setActive: () => {},
      delete: () => {},
    };
    const chunks: Array<(c: string) => void> = [];
    s.pool.setFactory(
      (id: string) =>
        ({
          sessionId: id,
          agent: {
            run: (_t: string, onChunk?: (c: string) => void) => {
              if (onChunk) chunks.push(onChunk);
              return new Promise(() => {});
            },
            shutdown: () => {},
          },
          contextManager: { addPendingImage: () => {} },
          execModule: { getActivePlan: () => null },
        }) as never,
    );

    await withServer(s, async (base) => {
      const ac = new AbortController();
      const res = await doFetch(`${base}/events?session=A`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const read = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value);
          }
        } catch {
          /* aborted */
        }
      })();
      await new Promise((r) => setTimeout(r, 60));

      const post = await postJson(base, "/api/message", { text: "hi", sessionId: "A" });
      expect(post.status).toBe(202);
      chunks[0]?.("hello-stream");
      await new Promise((r) => setTimeout(r, 600));
      ac.abort();
      await read;

      expect(buf).toContain("hello-stream");
      expect(buf).toContain('"sessionId":"A"');
    });
  });
});
