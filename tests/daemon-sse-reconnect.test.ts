import { describe, expect, it } from "vitest";
import { RemoteEventStream } from "../src/modules/daemon/remote-host-events";

const FRAME = `id: 5
data: {"v":1,"seq":5,"ts":1,"type":"text.delta","sessionId":"S1","data":{"chunk":"hi"}}

`;

function streamFetch() {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(FRAME, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("daemon SSE auto-reconnect (W8)", () => {
  it("reconnects after a closed stream and resumes from Last-Event-ID", async () => {
    const { impl, calls } = streamFetch();
    const events: string[] = [];
    const stream = new RemoteEventStream({
      streamUrl: () => "http://daemon/v1/host/sessions/S1/stream",
      retryMs: 5,
      fetchImpl: impl,
    });
    const unsubscribe = stream.subscribe((ev) => events.push(ev.type));

    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]?.headers["Last-Event-ID"]).toBe("5");
    expect(events.length).toBeGreaterThanOrEqual(2);

    unsubscribe();
    stream.dispose();
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(after);
  });
});
