/**
 * Контрактная документация сервиса: `GET /v1/openapi.json` и `GET /v1/docs`.
 *
 * Проверяем три вещи: (1) спека описывает весь реальный контракт и остаётся
 * валидной JSON-структурой, (2) discovery открыт без bearer-токена, но
 * tenant-данные — нет, (3) схемы не разошлись с типами, которые реально
 * сериализуются в ответы.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startAgentService } from "../../src/modules/service/module";
import { buildOpenApiDocument } from "../../src/modules/service/openapi/document";
import { OPERATIONS } from "../../src/modules/service/openapi/operations";
import { renderDocsPage } from "../../src/modules/service/openapi/docs-page";
import { SCHEMAS } from "../../src/modules/service/openapi/schemas";
import type { ServiceDeps } from "../../src/modules/service/state";
import { DEFAULTS } from "../../src/config/defaults";
import type { Agent } from "../../src/core/agent";
import { httpJson, httpRequest } from "./http-client";

/** Реальные маршруты сервиса: точные (`API_ROUTES`) + параметрические группы. */
const ROUTED: Array<[string, string]> = [
  ["GET", "/v1/health"],
  ["GET", "/v1/ready"],
  ["GET", "/v1/openapi.json"],
  ["GET", "/v1/docs"],
  ["POST", "/v1/sessions"],
  ["GET", "/v1/sessions"],
  ["GET", "/v1/sessions/{sessionId}"],
  ["DELETE", "/v1/sessions/{sessionId}"],
  ["POST", "/v1/sessions/{sessionId}/tasks"],
  ["GET", "/v1/tasks/{jobId}"],
  ["POST", "/v1/tasks/{jobId}/cancel"],
  ["POST", "/v1/tasks/{jobId}/answer"],
  ["GET", "/v1/sessions/{sessionId}/events"],
];

function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  const config = structuredClone(DEFAULTS);
  config.service.host = "127.0.0.1";
  config.service.port = 0;
  config.service.token = undefined;
  return { agent: {} as unknown as Agent, config, ...overrides };
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

/** Поднимает сервис (опционально с токеном) и отдаёт его базовый URL. */
async function serve(token?: string): Promise<string> {
  const svc = startAgentService(makeDeps(token ? { token } : {}));
  stop = svc.stop;
  return svc.url;
}

describe("openapi document", () => {
  it("is an OpenAPI 3.1 document with bearer security and a bearer scheme", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    expect(doc.openapi).toBe("3.1.0");
    const info = doc.info as Record<string, unknown>;
    expect(info.title).toBe("MMA Agent Service API");
    expect(String(info.version)).toContain("2.37.0");
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    const schemes = (doc.components as Record<string, Record<string, unknown>>).securitySchemes;
    expect(schemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  });

  it("drops the root security when no token is configured", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: false });
    expect(doc.security).toEqual([]);
  });

  it("covers every routed endpoint and nothing that is not routed", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const documented = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(documented.sort()).toEqual(ROUTED.map((r) => r.join(" ")).sort());
  });

  it("gives every operation a unique id, a tag and a 2xx response", () => {
    const ids = OPERATIONS.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of OPERATIONS) {
      expect(op.summary.length).toBeGreaterThan(0);
      expect(op.tag.length).toBeGreaterThan(0);
      const codes = Object.keys(op.responses);
      expect(codes.some((c) => c.startsWith("2")), `${op.operationId} has no success response`).toBe(true);
    }
  });

  it("marks probes and discovery as open, tenant routes as protected", () => {
    const open = OPERATIONS.filter((op) => op.open).map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(open.sort()).toEqual([
      "GET /v1/docs",
      "GET /v1/health",
      "GET /v1/openapi.json",
      "GET /v1/ready",
    ]);
  });

  it("relaxes security per-operation on open routes when a token is required", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/v1/health"].get.security).toEqual([]);
    expect(paths["/v1/openapi.json"].get.security).toEqual([]);
    expect(paths["/v1/sessions"].post.security).toBeUndefined();
  });

  it("keeps schemas in sync with the serialized contract types", () => {
    const job = SCHEMAS.JobObject as { properties: Record<string, unknown> };
    // Job-объект — общий для pull, webhook и sync-сабмита: расхождение здесь
    // ломает интегратора молча (поле просто не приходит).
    for (const field of [
      "jobId",
      "sessionId",
      "status",
      "mode",
      "result",
      "usage",
      "error",
      "createdAt",
      "startedAt",
      "finishedAt",
    ]) {
      expect(job.properties[field], `JobObject.${field}`).toBeDefined();
    }
    const problem = SCHEMAS.ProblemDetails as { properties: Record<string, unknown> };
    for (const field of ["type", "title", "status", "is_retriable", "retry_after_ms"]) {
      expect(problem.properties[field], `ProblemDetails.${field}`).toBeDefined();
    }
    const submit = SCHEMAS.TaskSubmitRequest as { properties: Record<string, unknown> };
    for (const field of ["input", "mode", "output", "toolAllowlist", "timeoutMs", "callbackUrl", "wait"]) {
      expect(submit.properties[field], `TaskSubmitRequest.${field}`).toBeDefined();
    }
  });

  it("has no dangling $ref in paths or components (a broken ref breaks Swagger UI)", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    const schemas = (doc.components as Record<string, Record<string, unknown>>).schemas;
    const refs = new Set<string>();
    JSON.stringify({ paths: doc.paths, components: doc.components }, (key, value) => {
      if (key === "$ref") refs.add(String(value).split("/").pop() ?? "");
      return value;
    });
    expect(refs.size).toBeGreaterThan(0);
    const dangling = [...refs].filter((name) => !(name in schemas));
    expect(dangling).toEqual([]);
  });

  it("declares runtime facts as a root specification extension", () => {
    // `x-runtime` в корне, а не внутри `info`: расширения спецификации живут
    // на верхнем уровне, иначе потребитель (Redoc/Postman) их не покажет.
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    expect(doc["x-runtime"]).toMatchObject({
      mmaVersion: "2.37.0",
      authRequired: true,
      isolation: "one process per tenant",
    });
    const info = doc.info as Record<string, unknown>;
    expect(info["x-runtime"]).toBeUndefined();
  });

  it("serves the HTML docs page as text/html, not application/json", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: false });
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const content = paths["/v1/docs"].get.responses as Record<
      string,
      { content: Record<string, unknown> }
    >;
    expect(Object.keys(content["200"].content)).toEqual(["text/html"]);
    const health = paths["/v1/health"].get.responses as Record<
      string,
      { content: Record<string, unknown> }
    >;
    expect(Object.keys(health["200"].content)).toEqual(["application/json"]);
  });

  it("survives a JSON round trip (no undefined/functions leaking into the document)", () => {
    const doc = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("returns a fresh object on each build", () => {
    const a = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    (a.paths as Record<string, unknown>)["/v1/health"] = "mutated";
    const b = buildOpenApiDocument({ version: "2.37.0", authRequired: true });
    expect((b.paths as Record<string, unknown>)["/v1/health"]).not.toBe("mutated");
  });
});

describe("docs page", () => {
  it("renders every operation, the quickstart and no external resources", () => {
    const html = renderDocsPage({ version: "2.37.0", authRequired: false });
    for (const op of OPERATIONS) {
      expect(html, `${op.method} ${op.path}`).toContain(op.path);
      expect(html, `summary of ${op.operationId}`).toContain(op.summary);
    }
    expect(html).toContain("Quickstart");
    expect(html).toContain("/v1/openapi.json");
    // Offline-first: страница не тянет ни CDN, ни шрифты из сети.
    expect(html).not.toMatch(/https?:\/\/(?!mma\.dev|127\.0\.0\.1|localhost)[a-z]/i);
  });

  it("shows the auth header in the quickstart only when a token is required", () => {
    // Ищем именно в блоке quickstart: слово «Authorization: Bearer» законно
    // встречается и в описании 401-ответов.
    const quickstart = (html: string): string => html.slice(html.indexOf("<pre>"), html.indexOf("</pre>"));
    const anon = quickstart(renderDocsPage({ version: "2.37.0", authRequired: false }));
    const withToken = quickstart(renderDocsPage({ version: "2.37.0", authRequired: true }));
    expect(anon).not.toContain("Authorization: Bearer");
    expect(withToken).toContain("Authorization: Bearer $MMA_SERVICE_TOKEN");
  });

  it("escapes HTML in descriptions (contract text is code, not trusted input)", () => {
    const html = renderDocsPage({
      version: "2.37.0",
      authRequired: false,
      operations: [
        {
          method: "get",
          path: "/v1/x",
          operationId: "x",
          tag: "ops",
          summary: "<img src=x onerror=alert(1)>",
          responses: { "200": { description: "ok" } },
        },
      ],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("discovery routes", () => {
  it("serves the spec without a bearer token", async () => {
    const url = await serve("secret");
    const res = await httpJson(`${url}/v1/openapi.json`);
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect(res.json.openapi).toBe("3.1.0");
    // Токен задан → корень объявляет bearer, discovery-маршруты его снимают.
    expect(res.json.security).toEqual([{ bearerAuth: [] }]);
    const paths = res.json.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/v1/health"].get.security).toEqual([]);
  });

  it("serves the human docs page as self-contained HTML", async () => {
    const url = await serve();
    const res = await httpRequest(`${url}/v1/docs`);
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/html");
    expect(res.body).toContain("MMA Agent Service API");
    expect(res.body).toContain("/v1/sessions/{sessionId}/tasks");
  });

  it("still requires the token for tenant data", async () => {
    const url = await serve("secret");
    const res = await httpJson(`${url}/v1/sessions`);
    expect(res.status).toBe(401);
  });

  it("reflects the runtime version in info.version", async () => {
    const url = await serve();
    const res = await httpJson(`${url}/v1/openapi.json`);
    const info = res.json.info as Record<string, unknown>;
    expect(String(info.version)).toMatch(/^1\.0\.0\+mma-\d+\.\d+\.\d+$/);
  });
});
