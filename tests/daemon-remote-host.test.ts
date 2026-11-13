import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteHost } from "../src/modules/daemon/remote-host";
import type { HostEvent } from "../src/core/host";

/**
 * W2: тонкий клиент `RemoteHost` говорит только по wire — без Agent/SessionManager.
 */

let server: Server | undefined;
const seen: string[] = [];

function envelope(seq: number, type: string, data: unknown): string {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({
    v: 1,
    seq,
    ts: 1000 + seq,
    type,
    sessionId: "S",
    data,
  })}\n\n`;
}

async function startDaemon(opts: { streamScript?: string[] } = {}): Promise<string> {
  seen.length = 0;
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1/host/state")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: { busy: false, sessionId: "S" } }));
      return;
    }
    if (req.method === "GET" && url === "/v1/host/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: [{ id: "S" }] }));
      return;
    }
    if (req.method === "POST" && url === "/v1/host/sessions") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "S2", name: "x" }));
      return;
    }
    if (req.method === "DELETE" && url.startsWith("/v1/host/sessions/")) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.split("?")[0].endsWith("/history")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
      return;
    }
    if (req.method === "GET" && url.split("?")[0].endsWith("/log")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries: [{ type: "usage" }] }));
      return;
    }
    if (req.method === "GET" && url.endsWith("/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const frame of opts.streamScript ?? []) res.write(frame);
      return;
    }
    if (req.method === "POST" && url.endsWith("/submit")) {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jobId: "job_1", turnId: "job_1", sessionId: "S" }));
      return;
    }
    if (req.method === "POST" && url.endsWith("/command")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "POST") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("RemoteHost", () => {
  it("reads the state snapshot over wire", async () => {
    const baseUrl = await startDaemon();
    const host = new RemoteHost({ baseUrl, sessionId: "S" });
    await expect(host.getState()).resolves.toEqual({ busy: false, sessionId: "S" });
    host.dispose();
  });

  it("maps SSE envelopes into HostEvents and clears busy on terminal", async () => {
    const baseUrl = await startDaemon({
      streamScript: [envelope(1, "task.started", {}), envelope(2, "task.finished", { ok: true })],
    });
    const host = new RemoteHost({ baseUrl, sessionId: "S" });
    const events: HostEvent[] = [];
    host.subscribeEvents((ev) => events.push(ev));

    await waitFor(() => events.length >= 2);
    expect(events[0]).toMatchObject({ type: "task.started", sessionId: "S" });
    expect(events[1]).toMatchObject({ type: "task.finished" });
    expect(events[1].data).toEqual({ ok: true });
    expect(host.isBusy()).toBe(false);
    host.dispose();
  });

  it("submits over wire and marks itself busy", async () => {
    const baseUrl = await startDaemon({ streamScript: [envelope(1, "task.started", {})] });
    const host = new RemoteHost({ baseUrl, sessionId: "S" });
    await expect(host.submit("hello")).resolves.toMatchObject({ jobId: "job_1" });
    expect(host.isBusy()).toBe(true);
    expect(seen).toContain("POST /v1/host/sessions/S/submit");
    host.dispose();
  });

  it("routes control calls and reports missing command support", async () => {
    const baseUrl = await startDaemon();
    const host = new RemoteHost({ baseUrl, sessionId: "S" });
    await host.pause();
    await host.resume();
    await host.answer("q1", 0);
    host.interrupt();
    await expect(host.executeCommand("/status")).rejects.toThrow(/command failed: 404/);
    host.dispose();
  });

  it("reads sessions, history and log over wire", async () => {
    const baseUrl = await startDaemon();
    const host = new RemoteHost({ baseUrl, sessionId: "S" });
    await expect(host.listSessions()).resolves.toEqual([{ id: "S" }]);
    await expect(host.createSession("x")).resolves.toMatchObject({ id: "S2" });
    await host.deleteSession("S");
    await expect(host.getHistory("S")).resolves.toEqual([{ role: "user", content: "hi" }]);
    await expect(host.getLog("S", { limit: 5 })).resolves.toEqual([{ type: "usage" }]);
    expect(seen).toContain("DELETE /v1/host/sessions/S");
    host.dispose();
  });

  it("rejects images instead of silently dropping them", async () => {
    const baseUrl = await startDaemon();
    const host = new RemoteHost({ baseUrl, sessionId: "S" });
    await expect(host.submit("hi", { images: ["data:image/png;base64,AA=="] })).rejects.toThrow(
      /images are not supported/,
    );
    host.dispose();
  });
});
