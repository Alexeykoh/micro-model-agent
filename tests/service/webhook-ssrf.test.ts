/**
 * W10.4: callbackUrl проходит политику (https/SSRF), подпись проверяема,
 * доставка ограничена дедлайном, redirect'ы не преследуются.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentResult } from "../../src/core/types";
import { DEFAULT_SECURITY_CONFIG } from "../../src/config/security";
import { startAgentService } from "../../src/modules/service/module";
import { checkCallbackUrl } from "../../src/modules/service/runtime/callback-url";
import {
  SIGNATURE_WINDOW_MS,
  WEBHOOK_DEADLINE_MS,
  deliverWebhook,
  signature,
  verifySignature,
} from "../../src/modules/service/runtime/webhook";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  dir = tempServiceDir();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

function fastAgent(): unknown {
  return {
    async run(): Promise<AgentResult> {
      return { success: true, text: "ok", iterationCount: 1 };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

describe("callbackUrl policy", () => {
  it("requires https for a public host", () => {
    expect(checkCallbackUrl("http://callback.example/hook").allowed).toBe(false);
    expect(checkCallbackUrl("https://callback.example/hook").allowed).toBe(true);
  });

  it("allows http only for loopback and only with the explicit flag", () => {
    const loopback = "http://127.0.0.1:9200/hook";
    expect(checkCallbackUrl(loopback).allowed).toBe(false);
    expect(checkCallbackUrl(loopback, { allowHttp: true }).allowed).toBe(false); // SSRF-политика
    expect(
      checkCallbackUrl(loopback, {
        allowHttp: true,
        networkConfig: {
          ...DEFAULT_SECURITY_CONFIG.network,
          allowPrivateOutbound: true,
        },
      }).allowed,
    ).toBe(true);
  });

  it("refuses a private address even over https", () => {
    expect(checkCallbackUrl("https://169.254.169.254/latest").allowed).toBe(false);
  });

  it("rejects a non-http(s) scheme and a malformed URL", () => {
    expect(checkCallbackUrl("file:///etc/passwd").allowed).toBe(false);
    expect(checkCallbackUrl("not a url").allowed).toBe(false);
  });

  it("422s an http callback on submit", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const res = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "x", mode: "job", wait: true, callbackUrl: "http://callback.example/hook" },
    });
    expect(res.status).toBe(422);
    expect(res.json.title).toBe("callbackUrl not allowed");
  });

  it("accepts an https callback on submit", async () => {
    const svc = startAgentService(makeServiceDeps({ dir, agent: fastAgent() }));
    stop = svc.stop;
    const url = await svc.url;
    const sid = await firstSessionId(url);
    const res = await httpJson(`${url}/v1/sessions/${sid}/tasks`, {
      method: "POST",
      json: { input: "x", mode: "job", wait: true, callbackUrl: "https://callback.example/hook" },
    });
    expect(res.json.status).toBe("succeeded");
  });
});

describe("signature verification", () => {
  const timestamp = new Date(1_700_000_000_000).toISOString();
  const body = '{"jobId":"job_1"}';
  const secret = "s3cr3t";
  const sig = signature(secret, timestamp, body);

  it("accepts a fresh, untampered signature", () => {
    expect(verifySignature({ secret, body, signature: sig, timestamp, now: 1_700_000_000_000 })).toBe(true);
  });

  it("rejects a replay outside the window", () => {
    expect(
      verifySignature({
        secret,
        body,
        signature: sig,
        timestamp,
        now: 1_700_000_000_000 + SIGNATURE_WINDOW_MS + 1,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body, wrong secret and malformed timestamp", () => {
    expect(
      verifySignature({
        secret,
        body: `${body} `,
        signature: sig,
        timestamp,
        now: 1_700_000_000_000,
      }),
    ).toBe(false);
    expect(
      verifySignature({
        secret: "other",
        body,
        signature: sig,
        timestamp,
        now: 1_700_000_000_000,
      }),
    ).toBe(false);
    expect(
      verifySignature({ secret, body, signature: sig, timestamp: "never", now: 1_700_000_000_000 }),
    ).toBe(false);
  });
});

interface Call {
  headers: Record<string, string>;
  init?: RequestInit;
}

function capture(statuses: number[]): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    calls.push({ headers: (init?.headers ?? {}) as Record<string, string>, init });
    const status = statuses[calls.length - 1] ?? 503;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("webhook delivery bounds", () => {
  it("keeps one timestamp across retries and counts attempts", async () => {
    const { calls, fetchImpl } = capture([503, 503, 200]);
    const result = await deliverWebhook({
      url: "https://callback.example/hook",
      secret: "k",
      eventId: "evt_1",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    const stamps = calls.map((c) => c.headers["X-Mma-Timestamp"]);
    expect(new Set(stamps).size).toBe(1);
    expect(calls.map((c) => c.headers["X-Mma-Delivery"])).toEqual(["1", "2", "3"]);
    for (const call of calls) {
      expect(call.headers["X-Mma-Signature"]).toBe(signature("k", stamps[0], "{}"));
    }
  });

  it("treats a redirect as terminal and never follows it", async () => {
    const { calls, fetchImpl } = capture([302, 200]);
    const result = await deliverWebhook({
      url: "https://callback.example/hook",
      eventId: "evt_302",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: false, attempts: 1, lastStatus: 302 });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.redirect).toBe("manual");
  });

  it("backs off exponentially with a reachable cap", async () => {
    const { fetchImpl } = capture([503, 503, 503, 503, 503, 200]);
    const delays: number[] = [];
    const result = await deliverWebhook({
      url: "https://callback.example/hook",
      eventId: "evt_backoff",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.attempts).toBe(6);
    expect(delays).toHaveLength(5);
    expect(delays[0]).toBeGreaterThanOrEqual(2000);
    expect(delays[4]).toBeGreaterThanOrEqual(32_000);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    expect(delays[4]).toBeLessThan(60_000 + 250);
  });

  it("stops retrying at the overall deadline", async () => {
    let now = 0;
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      now += 50_000;
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch;
    const result = await deliverWebhook({
      url: "https://callback.example/hook",
      eventId: "evt_deadline",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      now: () => now,
      sleep: async () => {},
    });
    expect(attempts).toBeLessThan(6);
    expect(result.ok).toBe(false);
    expect(now).toBeLessThanOrEqual(WEBHOOK_DEADLINE_MS + 50_000);
  });

  it("blocks a private https callback without any attempt", async () => {
    const { calls, fetchImpl } = capture([200]);
    const result = await deliverWebhook({
      url: "https://169.254.169.254/latest/meta-data",
      eventId: "evt_ssrf",
      body: "{}",
      timeoutMs: 1000,
      fetchImpl,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ ok: false, attempts: 0, blocked: true });
    expect(calls).toHaveLength(0);
  });
});
