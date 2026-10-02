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

describe("webui SSE delivery (multi-tab)", () => {
  it("delivers every session's events to all clients (background tabs stream live)", () => {
    const s = createWebUiState();
    const a: string[] = [];
    const b: string[] = [];
    s.clients.add(fakeClient(a));
    s.clients.add(fakeClient(b));

    broadcast({ type: "text", ts: 1, sessionId: "A", chunk: "hello-a" }, s);
    broadcast({ type: "text", ts: 2, sessionId: "B", chunk: "hello-b" }, s);

    // Each client sees both sessions' streams; tabs are split client-side.
    expect(a.join("")).toContain("hello-a");
    expect(a.join("")).toContain("hello-b");
    expect(b.join("")).toContain("hello-a");
    expect(b.join("")).toContain("hello-b");
  });

  it("delivers global events (no sessionId) to everyone", () => {
    const s = createWebUiState();
    const a: string[] = [];
    const b: string[] = [];
    s.clients.add(fakeClient(a));
    s.clients.add(fakeClient(b));

    broadcast({ type: "state", ts: 1, busy: true }, s);
    expect(a.join("")).toContain('"busy":true');
    expect(b.join("")).toContain('"busy":true');
  });

  it("does not auto-stamp activeSessionId onto global events", () => {
    const s = createWebUiState();
    s.activeSessionId = "A";
    const chunks: string[] = [];
    s.clients.add(fakeClient(chunks));

    broadcast({ type: "state", ts: 1, busy: false }, s);
    expect(chunks.join("")).not.toContain('"sessionId":"A"');
  });
});

describe("webui SSE end-to-end", () => {
  it("a connected client receives a runner's stream for its session", async () => {
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
      const res = await doFetch(`${base}/events`, { signal: ac.signal });
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
