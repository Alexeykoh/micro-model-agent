import { describe, expect, it } from "vitest";
import { deliverWebhook, signature } from "../../src/modules/service/runtime/webhook";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function captureFetch(statuses: number[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), headers, body: String(init?.body ?? "") });
    const status = statuses[calls.length - 1] ?? 200;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const noSleep = async () => {};

describe("webhook delivery", () => {
  it("signs with HMAC-SHA256 over timestamp.body and succeeds on 2xx", async () => {
    const { calls, fetchImpl } = captureFetch([200]);
    const body = '{"jobId":"job_1"}';
    const result = await deliverWebhook({
      url: "https://example.com/hook",
      secret: "s3cr3t",
      eventId: "evt_1",
      body,
      timeoutMs: 1000,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    const call = calls[0];
    expect(call.headers["X-Mma-Event-Id"]).toBe("evt_1");
    expect(call.headers["X-Mma-Signature"]).toBe(
      signature("s3cr3t", call.headers["X-Mma-Timestamp"], body),
    );
  });

  it("retries on 5xx keeping the event id stable", async () => {
    const { calls, fetchImpl } = captureFetch([503, 200]);
    const result = await deliverWebhook({
      url: "https://example.com/hook",
      secret: "k",
      eventId: "evt_stable",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(calls.map((c) => c.headers["X-Mma-Event-Id"])).toEqual(["evt_stable", "evt_stable"]);
  });

  it("does not retry on a 4xx (other than 429)", async () => {
    const { calls, fetchImpl } = captureFetch([400, 200]);
    const result = await deliverWebhook({
      url: "https://example.com/hook",
      eventId: "evt_1",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("omits the signature header when no secret is configured", async () => {
    const { calls, fetchImpl } = captureFetch([200]);
    await deliverWebhook({
      url: "https://example.com/hook",
      eventId: "evt_1",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: noSleep,
    });
    expect(calls[0].headers["X-Mma-Signature"]).toBeUndefined();
  });

  it("gives up after the timeout aborts the request", async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const result = await deliverWebhook({
      url: "https://example.com/hook",
      eventId: "evt_1",
      body: "{}",
      timeoutMs: 20,
      maxAttempts: 1,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("retries 429", async () => {
    const { calls, fetchImpl } = captureFetch([429, 200]);
    const result = await deliverWebhook({
      url: "https://example.com/hook",
      eventId: "evt_1",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
