/**
 * Конформанс API: ответы сервиса ↔ объявленная OpenAPI-спецификация.
 *
 * Спека пишется руками, поэтому проверяем её как внешний потребитель:
 *   1. код каждого ответа объявлен для этой операции;
 *   2. тело соответствует схеме в обе стороны (нет необъявленных полей,
 *      все объявленные обязательные пришли, enum'ы валидны);
 *   3. объявленные заголовки реально приходят;
 *   4. auth ведёт себя как объявлено: защищённые маршруты отвергают, открытые —
 *      нет, и в спеке это отражено.
 *
 * Плюс сквозные срезы, которые ломаются первыми при правках рантайма:
 * идемпотентность, очередь, отмена, битые тела, неверный метод, тип ошибки.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { AgentResult, ToolEvent } from "../../src/core/types";
import { startAgentService } from "../../src/modules/service/module";
import { buildOpenApiDocument } from "../../src/modules/service/openapi/document";
import { readMmaVersion } from "../../src/core/version";
import type { SpecLike } from "./contract-helpers";
import {
  captureSse,
  checkShape,
  declaredEventTypes,
  declaredHeaders,
  declaredStatuses,
  emittedEventTypes,
  isOpenOperation,
  successSchema,
} from "./contract-helpers";
import { httpJson, httpRequest } from "./http-client";
import { cleanupServiceDir, firstSessionId, makeServiceDeps, tempServiceDir } from "./harness";

const TOKEN = "contract-token";

/** Спека ровно того рантайма, который поднимаем ниже. */
function spec(): SpecLike {
  return buildOpenApiDocument({ version: readMmaVersion(), authRequired: true }) as unknown as SpecLike;
}

/** Агент-заглушка: стримит текст, эмитит tool-события, терминальный успех. */
function stubAgent(text = "contract ok"): unknown {
  return {
    async run(
      _input: string,
      onChunk?: (c: string) => void,
      _onMeta?: unknown,
      onTool?: (ev: ToolEvent) => void,
    ): Promise<AgentResult> {
      onChunk?.(text);
      onTool?.({ type: "start", tool: "read_file", args: { path: "a" } });
      onTool?.({ type: "end", tool: "read_file", args: { path: "a" }, output: "ok", duration: 1 });
      return {
        success: true,
        text,
        iterationCount: 1,
        promptTokens: 7,
        completionTokens: 3,
        totalCost: 0,
      };
    },
    setPromptIO() {},
    shutdown() {},
  };
}

/** Агент, который висит, пока его не сольют (для проверки очереди/отмены). */
function hangingAgent(): { agent: unknown; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    agent: {
      async run(): Promise<AgentResult> {
        await gate;
        return { success: true, text: "released", iterationCount: 1 };
      },
      setPromptIO() {},
      shutdown() {},
    },
    release,
  };
}

let dir: string;
let stop: (() => void) | undefined;
let base: string;

async function startService(agent: unknown, opts: { token?: string; maxQueue?: number } = {}): Promise<string> {
  const deps = makeServiceDeps({
    dir,
    agent,
    patch: (c) => {
      if (opts.maxQueue !== undefined) c.service.maxQueueLength = opts.maxQueue;
    },
  });
  if (opts.token) deps.token = opts.token;
  const svc = startAgentService(deps);
  stop = svc.stop;
  return svc.url;
}

const auth = (token = TOKEN): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/** GET/POST с телом, как это делает внешний клиент. */
function call(
  url: string,
  method: string,
  path: string,
  opts: { json?: unknown; headers?: Record<string, string> } = {},
) {
  return httpJson(`${url}${path}`, { method, ...opts });
}

/** Id сессии из harness (с auth — сервис в этих тестах всегда под токеном). */
async function sid(url: string): Promise<string> {
  return firstSessionId(url, auth());
}

beforeEach(() => {
  dir = tempServiceDir();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  cleanupServiceDir(dir);
});

describe("status codes are declared in the spec", () => {
  it("declares every status the happy paths actually return", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);

    const probes: Array<{ method: string; path: string; status: number }> = [
      { method: "GET", path: "/v1/sessions", status: 200 },
      { method: "POST", path: "/v1/sessions", status: 201 },
      { method: "GET", path: "/v1/sessions/{sessionId}", status: 200 },
      { method: "POST", path: "/v1/sessions/{sessionId}/tasks", status: 202 },
      { method: "GET", path: "/v1/tasks/{jobId}", status: 200 },
    ];

    const created = await call(url, "POST", "/v1/sessions", { json: { name: "x" }, headers: auth() });
    expect(created.status).toBe(201);
    const submit = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "hi", mode: "job" },
      headers: auth(),
    });
    const jobId = String(submit.json.jobId ?? "");
    expect(submit.status).toBe(202);

    const got = await call(url, "GET", `/v1/sessions/${sessionId}`, { headers: auth() });
    expect(got.status).toBe(200);
    const task = await call(url, "GET", `/v1/tasks/${jobId}`, { headers: auth() });
    expect(task.status).toBe(200);
    const deleted = await httpRequest(`${url}/v1/sessions/${sessionId}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(deleted.status).toBe(204);

    for (const probe of probes) {
      const declared = declaredStatuses(s, probe.method.toLowerCase(), probe.path);
      expect(declared, `${probe.method} ${probe.path} не объявляет ${probe.status}`).toContain(
        String(probe.status),
      );
    }
    // DELETE-204 объявлен отдельной проверкой (в probes его нет из-за пути).
    expect(declaredStatuses(s, "delete", "/v1/sessions/{sessionId}")).toContain("204");
  });

  it("declares every status the error paths actually return", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);

    const cases: Array<{
      method: string;
      path: string;
      specPath: string;
      body: unknown;
      status: number;
      headers?: Record<string, string>;
    }> = [
      { method: "GET", path: "/v1/sessions/none", specPath: "/v1/sessions/{sessionId}", body: undefined, status: 404, headers: auth() },
      { method: "GET", path: "/v1/tasks/none", specPath: "/v1/tasks/{jobId}", body: undefined, status: 404, headers: auth() },
      {
        method: "POST",
        path: "/v1/sessions/none/tasks",
        specPath: "/v1/sessions/{sessionId}/tasks",
        body: { input: "x" },
        status: 404,
        headers: auth(),
      },
      { method: "GET", path: "/v1/sessions", specPath: "/v1/sessions", body: undefined, status: 401 },
      {
        method: "POST",
        path: "/v1/sessions",
        specPath: "/v1/sessions",
        body: undefined,
        status: 401,
        headers: auth("wrong"),
      },
      {
        method: "POST",
        path: `/v1/sessions/${sessionId}/tasks`,
        specPath: "/v1/sessions/{sessionId}/tasks",
        body: { input: "   " },
        status: 400,
        headers: auth(),
      },
      {
        method: "POST",
        path: `/v1/sessions/${sessionId}/tasks`,
        specPath: "/v1/sessions/{sessionId}/tasks",
        body: { input: "x", output: { format: "xml" } },
        status: 422,
        headers: auth(),
      },
    ];

    for (const c of cases) {
      const res = await call(url, c.method, c.path, { json: c.body, headers: c.headers });
      expect(res.status, `${c.method} ${c.path}`).toBe(c.status);
      const declared = declaredStatuses(s, c.method.toLowerCase(), c.specPath);
      expect(declared, `${c.method} ${c.specPath} не объявляет ${c.status}`).toContain(
        String(c.status),
      );
      expect(String(res.headers["content-type"])).toContain("application/problem+json");
    }
  });

  it("declares queue-full, submit-validation and cancel-terminal statuses", async () => {
    const s = spec();
    const hanging = hangingAgent();
    const url = await startService(hanging.agent, { token: TOKEN, maxQueue: 1 });
    const sessionId = await sid(url);

    const first = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "long", mode: "job" },
      headers: auth(),
    });
    expect(first.status).toBe(202);
    const second = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "queued", mode: "job" },
      headers: auth(),
    });
    expect(second.status).toBe(202);
    const third = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "overflow", mode: "job" },
      headers: auth(),
    });
    expect(third.status).toBe(429);
    expect(declaredStatuses(s, "post", "/v1/sessions/{sessionId}/tasks")).toContain("429");

    // cancel терминальной задачи → 200 (объявлен)
    const jobId = String(first.json.jobId);
    hanging.release();
    await new Promise((r) => setTimeout(r, 60));
    const cancel = await call(url, "POST", `/v1/tasks/${jobId}/cancel`, { headers: auth() });
    expect(cancel.status).toBe(200);
    expect(declaredStatuses(s, "post", "/v1/tasks/{jobId}/cancel")).toContain("200");
  });
});

describe("payloads match the declared schemas", () => {
  it("validates session, list, task and error bodies against the spec", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);

    const list = await call(url, "GET", "/v1/sessions", { headers: auth() });
    const listSchema = successSchema(s, "get", "/v1/sessions", "200")!;
    expect(checkShape(s, list.json, listSchema)).toEqual({ missing: [], extra: [] });

    const one = await call(url, "GET", `/v1/sessions/${sessionId}`, { headers: auth() });
    const oneSchema = successSchema(s, "get", "/v1/sessions/{sessionId}", "200")!;
    expect(checkShape(s, one.json, oneSchema)).toEqual({ missing: [], extra: [] });

    const submit = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      // job без allowlist = 0 тулов (S-04); stubAgent зовёт read_file.
      json: { input: "hi", mode: "job", toolAllowlist: ["read_file"] },
      headers: auth(),
    });
    const acceptedSchema = successSchema(s, "post", "/v1/sessions/{sessionId}/tasks", "202")!;
    expect(checkShape(s, submit.json, acceptedSchema)).toEqual({ missing: [], extra: [] });

    // Problem Details (404)
    const missing = await call(url, "GET", "/v1/tasks/nope", { headers: auth() });
    const problemSchema = successSchema(s, "get", "/v1/tasks/{jobId}", "404")!;
    expect(checkShape(s, missing.json, problemSchema)).toEqual({ missing: [], extra: [] });
    // type обязан быть одним из объявленных URI
    const problemTypes = (s.components.schemas.ProblemDetails.properties.type as { enum: string[] })
      .enum;
    expect(problemTypes).toContain(missing.json.type);

    // Дожидаемся терминала и сверяем JobObject
    const jobId = String(submit.json.jobId);
    for (let i = 0; i < 50; i++) {
      const t = await call(url, "GET", `/v1/tasks/${jobId}`, { headers: auth() });
      if (t.json.status === "succeeded" || t.json.status === "failed") {
        const jobSchema = successSchema(s, "get", "/v1/tasks/{jobId}", "200")!;
        expect(checkShape(s, t.json, jobSchema)).toEqual({ missing: [], extra: [] });
        expect(t.json.status).toBe("succeeded");
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`task ${jobId} never settled`);
  });

  it("serves the declared content types", async () => {
    const url = await startService(stubAgent(), { token: TOKEN });
    const specRes = await httpRequest(`${url}/v1/openapi.json`);
    expect(String(specRes.headers["content-type"])).toContain("application/json");
    const docsRes = await httpRequest(`${url}/v1/docs`);
    expect(String(docsRes.headers["content-type"])).toContain("text/html");
    const sessionRes = await httpRequest(`${url}/v1/sessions`, { headers: auth() });
    expect(String(sessionRes.headers["content-type"])).toContain("application/json");
  });
});

describe("declared headers are actually sent", () => {
  it("sends Location and Retry-After on the 202 submit, and they point at statusUrl", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);
    const res = await httpRequest(`${url}/v1/sessions/${sessionId}/tasks`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi", mode: "job" }),
    });

    expect(res.status).toBe(202);
    const declared = declaredHeaders(s, "post", "/v1/sessions/{sessionId}/tasks", "202");
    for (const header of declared) {
      expect(res.headers[String(header).toLowerCase()], `заголовок ${header} не пришёл`).toBeDefined();
    }
    const body = JSON.parse(res.body) as { jobId: string; statusUrl: string };
    expect(res.headers.location).toBe(body.statusUrl);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("auth behaves as the spec declares", () => {
  it("rejects every protected route without a token and accepts the right one", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);
    const routes: Array<[string, string, unknown]> = [
      ["GET", "/v1/sessions", undefined],
      ["POST", "/v1/sessions", { name: "a" }],
      ["GET", `/v1/sessions/${sessionId}`, undefined],
      ["POST", `/v1/sessions/${sessionId}/tasks`, { input: "x", mode: "job" }],
      ["GET", "/v1/tasks/none", undefined],
      ["POST", "/v1/tasks/none/cancel", undefined],
      ["POST", "/v1/tasks/none/answer", { id: "q", answer: "a" }],
    ];
    for (const [method, path, body] of routes) {
      // без токена → 401
      const noAuth = await call(url, method, path, { json: body });
      expect(noAuth.status, `${method} ${path} без токена`).toBe(401);
      // в спеке у защищённой операции нет security: []
      expect(isOpenOperation(s, method.toLowerCase(), path.replace(sessionId, "{sessionId}"))).toBe(
        false,
      );
      // с правильным токеном — не 401
      const withAuth = await call(url, method, path, { json: body, headers: auth() });
      expect(withAuth.status, `${method} ${path} с токеном`).not.toBe(401);
    }
  });

  it("leaves open routes reachable without a token, and marks them open in the spec", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    for (const path of ["/v1/health", "/v1/openapi.json", "/v1/docs"]) {
      const res = await httpRequest(`${url}${path}`);
      expect(res.status, `${path} без токена`).toBe(200);
      expect(isOpenOperation(s, "get", path)).toBe(true);
    }
  });

  it("drops auth entirely when no token is configured", async () => {
    const url = await startService(stubAgent());
    const res = await call(url, "GET", "/v1/sessions");
    expect(res.status).toBe(200);
  });
});

describe("event types in the spec match what the runtime emits", () => {
  const SERVICE_DIR = join(import.meta.dir, "..", "..", "src", "modules", "service");

  it("declares every emitted type and emits every declared type", () => {
    const s = spec();
    const declared = declaredEventTypes(s).sort();
    const emitted = emittedEventTypes(SERVICE_DIR);

    // В рантайме есть тип, о котором интегратор не узнает из контракта.
    const undeclared = emitted.filter((type) => !declared.includes(type));
    expect(undeclared, "эмитимые типы не объявлены в EventEnvelope.type").toEqual([]);

    // В контракте есть тип, которого никогда не будет: интегратор ждёт событие.
    const dead = declared.filter((type) => !emitted.includes(type));
    expect(dead, "объявленные типы никогда не эмитятся").toEqual([]);
  });

  it("emits SSE frames whose envelope matches EventEnvelope", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);

    const frames = await captureSse(url, sessionId, auth(), async () => {
      await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
        json: { input: "sse", mode: "job" },
        headers: auth(),
      });
      await new Promise((r) => setTimeout(r, 250));
    });

    const envelopeSchema = successSchema(s, "get", "/v1/sessions/{sessionId}/events", "200");
    expect(envelopeSchema).toBeUndefined(); // SSE отдаётся как поток, не как JSON-схема
    const eventSchema = s.components.schemas.EventEnvelope;

    const seqs: number[] = [];
    for (const frame of frames) {
      const env = JSON.parse(frame.data) as Record<string, unknown>;
      // Форма кадра: id = seq, event = type, data = envelope (документировано).
      expect(frame.id).toBe(String(env.seq));
      expect(frame.event).toBe(env.type);
      expect(env.v).toBe(1);
      expect(typeof env.ts).toBe("number");
      expect(env.sessionId).toBe(sessionId);
      expect(checkShape(s, env, eventSchema)).toEqual({ missing: [], extra: [] });
      seqs.push(Number(env.seq));
    }
    // seq монотонный на сессию
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBeGreaterThan(0);
    // Живой поток содержит и дискретные, и потоковые события
    const types = frames.map((f) => f.event);
    expect(types).toContain("task.started");
    expect(types.some((t) => t.endsWith(".delta") || t === "tool.start")).toBe(true);
  });

  it("sends a webhook body identical to the pull Job object", async () => {
    const s = spec();
    const calls: Array<{ body: string }> = [];
    const deps = makeServiceDeps({
      dir,
      agent: stubAgent("webhook me"),
      webhookFetch: (async (_u: string | URL, init?: RequestInit) => {
        calls.push({ body: String(init?.body ?? "") });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const svc = startAgentService(deps);
    stop = svc.stop;
    const url = await svc.url;
    const sessionId = await sid(url);

    const submit = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "hook", mode: "job", callbackUrl: "https://example.com/hook" },
      headers: auth(),
    });
    const jobId = String(submit.json.jobId);

    for (let i = 0; i < 60 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(calls.length, "webhook не доставлен").toBeGreaterThan(0);

    const pushed = JSON.parse(calls[0].body) as Record<string, unknown>;
    const pulled = await call(url, "GET", `/v1/tasks/${jobId}`, { headers: auth() });
    const jobSchema = successSchema(s, "get", "/v1/tasks/{jobId}", "200")!;

    // Колбэк и pull отдают один и тот же объект (доки это обещают).
    expect(pushed.jobId).toBe(pulled.json.jobId);
    expect(pushed.status).toBe(pulled.json.status);
    expect(pushed.sessionId).toBe(pulled.json.sessionId);
    expect(pushed.mode).toBe(pulled.json.mode);
    expect(checkShape(s, pushed, jobSchema)).toEqual({ missing: [], extra: [] });
  });
});

describe("error contract stays RFC 9457", () => {
  it("returns problem+json with type/title/status for every failure mode", async () => {
    const url = await startService(stubAgent(), { token: TOKEN });

    const cases: Array<{ label: string; res: Awaited<ReturnType<typeof call>> }> = [
      { label: "unknown session", res: await call(url, "GET", "/v1/sessions/none", { headers: auth() }) },
      { label: "unknown task", res: await call(url, "GET", "/v1/tasks/none", { headers: auth() }) },
      {
        label: "empty input",
        res: await call(url, "POST", "/v1/sessions", { json: {}, headers: auth() }).then(
          async () => {
            const sessionId = await sid(url);
            return call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
              json: { input: "  " },
              headers: auth(),
            });
          },
        ),
      },
    ];

    for (const c of cases) {
      expect(c.res.status).toBeGreaterThanOrEqual(400);
      expect(String(c.res.headers["content-type"])).toContain("application/problem+json");
      expect(typeof c.res.json.type).toBe("string");
      expect(typeof c.res.json.title).toBe("string");
      expect(typeof c.res.json.status).toBe("number");
      // MMA-расширения присутствуют и типизированы
      expect(typeof c.res.json.is_retriable).toBe("boolean");
      expect(typeof c.res.json.retry_after_ms).toBe("number");
    }
  });

  it("returns problem+json for an unknown route and for a wrong method", async () => {
    const url = await startService(stubAgent(), { token: TOKEN });
    const unknown = await httpJson(`${url}/v1/nope`, { headers: auth() });
    expect(unknown.status).toBe(404);
    expect(String(unknown.headers["content-type"])).toContain("application/problem+json");

    // PATCH не поддерживается ни одной операцией → 404 problem (не 405), задокументировано
    const wrongMethod = await httpJson(`${url}/v1/sessions`, { method: "PATCH", headers: auth() });
    expect([404, 405]).toContain(wrongMethod.status);
    expect(String(wrongMethod.headers["content-type"])).toContain("application/problem+json");
  });

  it("answers 413 problem+json on an oversized body and keeps serving", async () => {
    const s = spec();
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);

    const oversized = await httpRequest(`${url}/v1/sessions/${sessionId}/tasks`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(2 * 1024 * 1024) }),
    });
    // Раньше реджект из readBody улетал из хендлера: клиент получал socket error,
    // а в Node — unhandled rejection, способный уронить процесс.
    expect(oversized.status).toBe(413);
    expect(String(oversized.headers["content-type"])).toContain("application/problem+json");
    expect(declaredStatuses(s, "post", "/v1/sessions/{sessionId}/tasks")).toContain("413");

    // Битое тело — тоже ответ, а не обрыв.
    const malformed = await httpRequest(`${url}/v1/sessions/${sessionId}/tasks`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);

    // Сервис жив и продолжает принимать работу.
    const alive = await httpJson(`${url}/v1/health`);
    expect(alive.status).toBe(200);
    const next = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "still works", mode: "job" },
      headers: auth(),
    });
    expect(next.status).toBe(202);
  });
});

describe("idempotency and queue behaviour match the spec text", () => {
  it("returns the same jobId for the same key+body and 409 for a different body", async () => {
    const url = await startService(stubAgent(), { token: TOKEN });
    const sessionId = await sid(url);
    const body = { input: "idem", mode: "job" };
    const key = { ...auth(), "Idempotency-Key": "k-1" };

    const first = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, { json: body, headers: key });
    const second = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, { json: body, headers: key });
    expect(first.status).toBe(202);
    expect(second.json.jobId).toBe(first.json.jobId);

    const conflict = await call(url, "POST", `/v1/sessions/${sessionId}/tasks`, {
      json: { input: "other", mode: "job" },
      headers: key,
    });
    expect(conflict.status).toBe(409);
  });
});
