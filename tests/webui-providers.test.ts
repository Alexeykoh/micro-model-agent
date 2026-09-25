import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

async function withServer(s: WebUiState, fn: (base: string) => Promise<void>): Promise<void> {
  const srv = createServer((req, res) => handleRequest(req, res, assets, s));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    srv.close();
  }
}

function testConfig(): AppConfig {
  const config = structuredClone(DEFAULTS);
  config.provider = {
    active: "local",
    entries: [
      {
        type: "openai-compat",
        label: "local",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "sk-local-secret",
        contextWindow: 32768,
        rateLimits: { maxRequestsPerMinute: 120, maxParallelTasks: 2 },
      },
      { type: "openrouter", label: "or", baseUrl: "https://openrouter.ai/api/v1" },
    ],
    type: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "sk-local-secret",
  };
  return config;
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await doFetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface ProviderBody {
  entries: Array<{ label: string; type: string; hasApiKey: boolean; rpm?: number; parallel?: number }>;
  active: string;
  name?: string;
  ok?: boolean;
  persisted?: boolean;
}

describe("webui providers REST", () => {
  it("GET /api/providers lists redacted entries + active (no apiKey)", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/providers`);
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain("sk-local-secret");
      const body = JSON.parse(raw) as ProviderBody;
      expect(body.active).toBe("local");
      expect(body.entries.map((e) => e.label)).toEqual(["local", "or"]);
      expect(body.entries[0].hasApiKey).toBe(true);
      expect(body.entries[1].hasApiKey).toBe(false);
      expect(body.entries[0].rpm).toBe(120);
      expect(body.entries[0].parallel).toBe(2);
    });
  });

  it("POST /api/providers adds an entry, persists, reconfigures", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    const saved: AppConfig[] = [];
    let reconfigured = 0;
    s.saveConfig = (cfg) => saved.push(cfg);
    s.reconfigure = () => {
      reconfigured++;
    };
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/providers", {
        type: "openai",
        label: "cloud",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-cloud",
        contextWindow: 128000,
        priority: 5,
        rpm: 60,
        parallel: 3,
      });
      expect(res.status).toBe(200);
      const body = res.json as ProviderBody;
      expect(body.ok).toBe(true);
      expect(body.name).toBe("cloud");
      expect(body.persisted).toBe(true);
      expect(body.entries.map((e) => e.label)).toEqual(["local", "or", "cloud"]);
      expect(JSON.stringify(body)).not.toContain("sk-cloud");
      expect(saved).toHaveLength(1);
      expect(reconfigured).toBe(1);
      const added = saved[0].provider.entries?.find((e) => e.label === "cloud");
      expect(added?.apiKey).toBe("sk-cloud");
      expect(added?.contextWindow).toBe(128000);
      expect(added?.rateLimits?.maxParallelTasks).toBe(3);
    });
  });

  it("POST /api/providers updates an existing entry by label and keeps its key", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/providers", {
        type: "openai-compat",
        label: "local",
        baseUrl: "http://localhost:9999/v1",
        contextWindow: 65536,
      });
      expect(res.status).toBe(200);
      const body = res.json as ProviderBody;
      expect(body.entries).toHaveLength(2);
      const local = s.config?.provider.entries?.find((e) => e.label === "local");
      expect(local?.baseUrl).toBe("http://localhost:9999/v1");
      expect(local?.contextWindow).toBe(65536);
      // Key not sent on update → preserved.
      expect(local?.apiKey).toBe("sk-local-secret");
    });
  });

  it("POST /api/providers rejects missing required fields with 400", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    let saved = 0;
    s.saveConfig = () => {
      saved++;
    };
    await withServer(s, async (base) => {
      const noType = await postJson(base, "/api/providers", { baseUrl: "http://x/v1" });
      expect(noType.status).toBe(400);
      expect(noType.json.error).toBe("invalid-provider");

      const badCtx = await postJson(base, "/api/providers", {
        type: "openai-compat",
        baseUrl: "http://x/v1",
        contextWindow: 10,
      });
      expect(badCtx.status).toBe(400);
      expect(saved).toBe(0);
    });
  });

  it("DELETE /api/providers/:name removes a non-active entry; active is guarded", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    let saved = 0;
    s.saveConfig = () => {
      saved++;
    };
    await withServer(s, async (base) => {
      const activeDel = await doFetch(`${base}/api/providers/local`, { method: "DELETE" });
      expect(activeDel.status).toBe(409);
      expect(((await activeDel.json()) as { error: string }).error).toBe("active-provider");

      const del = await doFetch(`${base}/api/providers/or`, { method: "DELETE" });
      expect(del.status).toBe(200);
      const body = (await del.json()) as ProviderBody;
      expect(body.ok).toBe(true);
      expect(body.entries.map((e) => e.label)).toEqual(["local"]);
      expect(saved).toBe(1);

      const missing = await doFetch(`${base}/api/providers/ghost`, { method: "DELETE" });
      expect(missing.status).toBe(404);
    });
  });

  it("returns 503 when config is not wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      expect((await doFetch(`${base}/api/providers`)).status).toBe(503);
      expect((await postJson(base, "/api/providers", { type: "x", baseUrl: "y" })).status).toBe(503);
      expect((await doFetch(`${base}/api/providers/x`, { method: "DELETE" })).status).toBe(503);
    });
  });

  it("requires a token when one is configured", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      expect((await doFetch(`${base}/api/providers`)).status).toBe(401);
      const allowed = await doFetch(`${base}/api/providers`, {
        headers: { "x-mma-token": "s3cret" },
      });
      expect(allowed.status).toBe(200);
    });
  });
});
