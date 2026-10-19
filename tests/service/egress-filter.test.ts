import { request } from "node:http";
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAgentService, type ServiceHandle } from "../../src/modules/service/module";
import { deliverWebhook, signature } from "../../src/modules/service/runtime/webhook";
import { apiGuard } from "../../src/modules/webui/egress";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import { httpJson } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

let dir: string;
let handle: ServiceHandle | undefined;

beforeEach(() => {
  dir = tempServiceDir();
});
afterEach(() => {
  handle?.stop();
  handle = undefined;
  cleanupServiceDir(dir);
});

async function boot(): Promise<string> {
  handle = startAgentService(makeServiceDeps({ dir }));
  return await handle.url;
}

/**
 * SSE-чтение через `node:http`: глобальный `fetch` в общем прогоне Bun
 * перетирается другими suite'ами (см. `tests/service/http-client.ts`).
 */
function sseRead(url: string, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const finish = (text: string): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.includes(needle)) {
            finish(buf);
            req.destroy();
          }
        });
        res.on("end", () => finish(buf));
      },
    );
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.end();
  });
}

describe("E2 serve: REST/SSE/webhook egress", () => {
  it("REST-ответ не отдаёт машинный путь из имени сессии", async () => {
    const url = await boot();
    const path = `${dir}\\secret-project`;
    await httpJson(`${url}/v1/sessions`, { method: "POST", json: { name: path } });
    const res = await httpJson(`${url}/v1/sessions`);
    const sessions = res.json.sessions as Array<{ name: string }>;
    const name = sessions.find((x) => x.name.includes("secret-project"))?.name ?? "";
    expect(name).not.toContain(dir);
    expect(name).toContain("<PATH:");
  });

  it("SSE редактирует фрейм, но буфер envelope'ов остаётся сырым (INV-D7)", async () => {
    const url = await boot();
    const sessionId = await firstSessionId(url);
    const rawPath = `${dir}\\secret\\a.txt`;
    const env = {
      v: 1 as const,
      seq: handle!.state.envelopes.next(sessionId),
      ts: Date.now(),
      type: "tool.start",
      sessionId,
      taskId: "task-1",
      data: { toolCallId: "c1", name: "read", args: { path: rawPath, host: hostname() } },
    };
    handle!.state.envelopes.append(env);

    const streamed = await sseRead(`${url}/v1/sessions/${sessionId}/events?since=0`, "tool.start");
    expect(streamed).not.toContain(dir);
    expect(streamed).not.toContain(hostname());
    expect(streamed).toContain("<PATH:");

    // Источник не мутирован: pull-источник правды остаётся полным.
    expect((env.data.args as { path: string }).path).toBe(rawPath);
    const stored = handle!.state.envelopes.since(sessionId, 0);
    expect((stored[0].data as { args: { path: string } }).args.path).toBe(rawPath);
  });

  it("токены не перетекают между workspace (1 тенант = 1 процесс)", () => {
    const other = tempServiceDir();
    try {
      const makeGuard = (workspace: string) => {
        const config = structuredClone(DEFAULTS) as AppConfig;
        config.security = {
          ...config.security,
          dataPolicy: { ...DEFAULT_DATA_POLICY, enabled: true },
        };
        return apiGuard({ config, workspace });
      };
      const a = makeGuard(dir)!.filterClient({ p: `${dir}\\a.txt` }) as { p: string };
      const b = makeGuard(other)!.filterClient({ p: `${other}\\a.txt` }) as { p: string };
      expect(a.p).toContain("<PATH:");
      expect(b.p).toContain("<PATH:");
      expect(a.p).not.toBe(b.p);
      expect(b.p).not.toContain(a.p);
    } finally {
      cleanupServiceDir(other);
    }
  });

  it("webhook-body редактируется, и HMAC считается по отредактированному телу", async () => {
    const config = structuredClone(DEFAULTS) as AppConfig;
    config.security = {
      ...config.security,
      dataPolicy: { ...DEFAULT_DATA_POLICY, enabled: true },
    };
    const guard = apiGuard({ config, workspace: dir });
    expect(guard).toBeDefined();

    let captured: { body: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured = {
        body: String(init?.body ?? ""),
        headers: { ...(init?.headers as Record<string, string>) },
      };
      return new Response("ok", { status: 204 });
    }) as typeof fetch;

    const secret = "test-secret";
    const res = await deliverWebhook({
      url: "https://example.com/hook",
      secret,
      eventId: "evt-1",
      body: JSON.stringify({ status: "succeeded", result: { path: `${dir}\\secret.txt` } }),
      timeoutMs: 1000,
      maxAttempts: 1,
      egress: guard,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.body).not.toContain(dir);
    expect(captured!.body).toContain("<PATH:");
    const ts = captured!.headers["X-Mma-Timestamp"];
    expect(captured!.headers["X-Mma-Signature"]).toBe(signature(secret, ts, captured!.body));
  });
});
