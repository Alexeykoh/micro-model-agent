import { describe, it, expect } from "vitest";
import { createWebUiState, } from "../src/modules/webui/state";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";
import { doFetch, postJson, withServer } from "./helpers/webui-server";




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


interface ProviderBody {
  entries: Array<{ label: string; type: string; hasApiKey: boolean; rpm?: number; parallel?: number }>;
  active: string;
  presets?: Array<{ id: string; type: string; name: string; label: string; baseUrl?: string }>;
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
      // Builtin presets are exposed so the form can fill type/URL in one click.
      const openrouter = body.presets?.find((p) => p.type === "openrouter");
      expect(openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(body.presets?.some((p) => p.type === "openai-compat")).toBe(true);
      // LM Studio graduated to a builtin preset with its own type.
      const lmstudio = body.presets?.find((p) => p.id === "lmstudio");
      expect(lmstudio?.type).toBe("lmstudio");
      expect(lmstudio?.baseUrl).toBe("http://localhost:1234/v1");
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
        originalName: "local",
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

  it("seeds the legacy single-provider config instead of dropping it", async () => {
    const s = createWebUiState();
    const cfg = structuredClone(DEFAULTS);
    cfg.provider = {
      type: "openai-compat",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "not-needed",
    };
    s.config = cfg;
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/providers", {
        type: "openrouter",
        label: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      });
      expect(res.status).toBe(200);
      const entries = s.config?.provider.entries ?? [];
      expect(entries.map((e) => e.label || e.type)).toEqual(["openai-compat", "openrouter"]);
      // The pre-existing provider stays active; the legacy flat fields are intact.
      expect(s.config?.provider.active).toBe("openai-compat");
      expect(s.config?.provider.type).toBe("openai-compat");
      expect(s.config?.provider.baseUrl).toBe("http://localhost:1234/v1");
    });
  });

  it("rejects a provider name that is already taken with 409 name-conflict", async () => {    const s = createWebUiState();
    s.config = testConfig();
    let saved = 0;
    s.saveConfig = () => {
      saved++;
    };
    await withServer(s, async (base) => {
      const dupLabel = await postJson(base, "/api/providers", {
        type: "openai-compat",
        label: "local",
        baseUrl: "http://x/v1",
      });
      expect(dupLabel.status).toBe(409);
      expect(dupLabel.json.error).toBe("name-conflict");

      // `openai-compat` is the type of the differently-labelled `local` entry.
      const typeAlias = await postJson(base, "/api/providers", {
        type: "openai-compat",
        label: "openai-compat",
        baseUrl: "http://x/v1",
      });
      expect(typeAlias.status).toBe(409);
      expect(saved).toBe(0);
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

  it("upserts provider cache + completion caps", async () => {
    const { upsertProvider } = await import("../src/modules/webui/settings/providers-api");
    const { DEFAULTS } = await import("../src/config/defaults");
    const cfg = structuredClone(DEFAULTS);
    const r = upsertProvider(cfg, { type: "openai-compat", baseUrl: "http://x/v1", maxCompletionTokens: 16384, cache: { mechanism: "local" } } as never);
    expect(r.ok).toBe(true);
    const entries = cfg.provider.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.maxCompletionTokens).toBe(16384);
    expect(last.cache?.mechanism).toBe("local");
  });

  it("lone legacy-seeded entry + colliding create-POST updates in place (no duplicate, no 409)", async () => {
    const { upsertProvider } = await import("../src/modules/webui/settings/providers-api");
    const { DEFAULTS } = await import("../src/config/defaults");
    const cfg = structuredClone(DEFAULTS);
    const r = upsertProvider(cfg, { type: "openai-compat", baseUrl: "http://new/v1" });
    expect(r).toEqual({ ok: true, name: "openai-compat" });
    expect(cfg.provider.entries).toHaveLength(1);
    expect(cfg.provider.entries?.[0].baseUrl).toBe("http://new/v1");
  });

  it("multi-entry colliding name without originalName is a name-conflict", async () => {
    const { upsertProvider } = await import("../src/modules/webui/settings/providers-api");
    const cfg = testConfig();
    const r = upsertProvider(cfg, { type: "openai-compat", label: "or", baseUrl: "http://x/v1" });
    expect(r).toEqual({ ok: false, error: "name-conflict" });
    expect(cfg.provider.entries).toHaveLength(2);
  });

  it("requires a token when one is configured", async () => {    const s = createWebUiState();
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
