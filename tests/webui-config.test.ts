import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState, type WebUiState, type WebSessionManager } from "../src/modules/webui/state";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";
import type { SessionMeta } from "../src/modules/session/types";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

// Other tests in the shared process may stub globalThis.fetch; use the runtime's
// own fetch so HTTP assertions stay real.
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
  config.provider.apiKey = "sk-test-secret";
  config.model = "original-model";
  return config;
}

function meta(id: string, name: string, active: boolean): SessionMeta {
  return {
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    messageCount: active ? 3 : 1,
    model: "m",
    contextWindow: 32768,
    projectDir: "/tmp",
  };
}

/** Minimal in-memory stub satisfying the structural WebSessionManager contract. */
function fakeSessions(initial: SessionMeta[], activeId: string | null): WebSessionManager {
  const store = new Map(initial.map((m) => [m.id, m]));
  let active = activeId;
  let seq = initial.length;
  return {
    list: () => [...store.values()],
    get: (id) => store.get(id) ?? null,
    getActive: () => active,
    setActive: (id) => {
      if (!store.has(id)) throw new Error("not found");
      active = id;
    },
    create: (name) => {
      seq++;
      const m = meta("s" + seq, name || "new", false);
      store.set(m.id, m);
      active = m.id;
      return m;
    },
    delete: (id) => {
      if (!store.has(id)) throw new Error("not found");
      store.delete(id);
      if (active === id) active = null;
    },
  };
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

describe("webui config/session/model REST", () => {
  it("GET /api/config returns redacted config + registry with enums", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/config");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        config: AppConfig;
        registry: Array<{ key: string; aliases: string[]; valueType: string; group: string; enum?: string[] }>;
      };
      expect(body.config.provider.apiKey).toBe("***");
      expect(body.config.model).toBe("original-model");
      expect(body.config.provider).toBeDefined();

      const byKey = new Map(body.registry.map((e) => [e.key, e]));
      expect(byKey.has("model")).toBe(true);
      expect(byKey.has("contextWindow")).toBe(true);
      expect(byKey.get("model")?.valueType).toBe("string");
      expect(byKey.get("model")?.aliases).toEqual([]);
      expect(byKey.get("reasoning.mode")?.enum).toContain("auto");
      expect(byKey.get("ui.verbosity")?.enum).toEqual(["quiet", "normal", "verbose"]);
      expect(byKey.get("locale")?.group).toBe("i18n");
    });
  });

  it("POST /api/config applies a valid key, persists, and reconfigures", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    const saved: AppConfig[] = [];
    let reconfigured = 0;
    s.saveConfig = (cfg) => saved.push(cfg);
    s.reconfigure = () => {
      reconfigured++;
    };

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "model", value: "new-model" });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.value).toBe("new-model");
      expect(res.json.persisted).toBe(true);
      expect(res.json.warning).toBeUndefined();
      expect(s.config?.model).toBe("new-model");
      expect(saved).toHaveLength(1);
      expect(saved[0].model).toBe("new-model");
      expect(reconfigured).toBe(1);
    });
  });

  it("POST /api/config accepts boolean/number values and coerces them", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.saveConfig = () => {};

    await withServer(s, async (base) => {
      const boolRes = await postJson(base, "/api/config", { key: "showReasoning", value: true });
      expect(boolRes.status).toBe(200);
      expect(s.config?.showReasoning).toBe(true);

      const intRes = await postJson(base, "/api/config", { key: "maxToolIterations", value: 5 });
      expect(intRes.status).toBe(200);
      expect(s.config?.maxToolIterations).toBe(5);
    });
  });

  it("POST /api/config reports not-persisted when saveConfig throws", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.saveConfig = () => {
      throw new Error("disk full");
    };

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "model", value: "new-model" });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.persisted).toBe(false);
      expect(typeof res.json.warning).toBe("string");
      // The in-memory config is still updated for this session.
      expect(s.config?.model).toBe("new-model");
    });
  });

  it("POST /api/config warns (without throwing) when reconfigure rejects", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.saveConfig = () => {};
    s.reconfigure = () => Promise.reject(new Error("provider down"));

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "model", value: "new-model" });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.persisted).toBe(true);
      expect(typeof res.json.warning).toBe("string");
    });
  });

  it("POST /api/config rejects an unknown key with 400", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    let saved = 0;
    s.saveConfig = () => {
      saved++;
    };

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "nope.key", value: "x" });
      expect(res.status).toBe(400);
      expect(res.json.ok).toBe(false);
      expect(res.json.error).toBe("unknown-key");
      expect(saved).toBe(0);
    });
  });

  it("POST /api/config rejects an invalid value with 400", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/config", { key: "contextWindow", value: "abc" });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid-value");
    });
  });

  it("GET /api/config returns 503 when config is not wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/config");
      expect(res.status).toBe(503);
    });
  });

  it("GET /api/sessions lists sessions; activate + delete hit the manager", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions(
      [meta("s1", "one", true), meta("s2", "two", false)],
      "s1",
    );

    await withServer(s, async (base) => {
      const list = await doFetch(base + "/api/sessions");
      expect(list.status).toBe(200);
      const body = (await list.json()) as { sessions: Array<Record<string, unknown>> };
      expect(body.sessions.map((x) => x.id).sort()).toEqual(["s1", "s2"]);
      expect(body.sessions[0]).toHaveProperty("messageCount");
      expect(body.sessions[0]).toHaveProperty("updatedAt");

      const ok = await postJson(base, "/api/sessions/activate", { id: "s2" });
      expect(ok.status).toBe(200);
      expect(s.sessionManager?.getActive()).toBe("s2");

      const missing = await postJson(base, "/api/sessions/activate", { id: "ghost" });
      expect(missing.status).toBe(404);

      // Active session cannot be deleted.
      const activeDel = await doFetch(base + "/api/sessions/s2", { method: "DELETE" });
      expect(activeDel.status).toBe(409);

      const del = await doFetch(base + "/api/sessions/s1", { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(s.sessionManager?.get("s1")).toBeNull();

      const unknownDel = await doFetch(base + "/api/sessions/ghost", { method: "DELETE" });
      expect(unknownDel.status).toBe(404);
    });
  });

  it("GET /api/config registry carries numeric min/max/step where applicable", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/config");
      const body = (await res.json()) as {
        registry: Array<{ key: string; min?: number; max?: number; step?: number }>;
      };
      const byKey = new Map(body.registry.map((e) => [e.key, e]));
      expect(byKey.get("contextWindow")?.min).toBe(1024);
      expect(byKey.get("contextWindow")?.step).toBe(1024);
      const system = byKey.get("contextBudget.systemPrompt");
      expect(system?.min).toBe(0.05);
      expect(system?.max).toBe(0.9);
      const reserve = byKey.get("contextBudget.responseReserve");
      expect(reserve?.min).toBe(0.05);
      expect(reserve?.max).toBe(0.9);
      expect(byKey.get("model")?.min).toBeUndefined();
    });
  });

  it("POST /api/sessions creates a session and returns its meta", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions([meta("s1", "one", true)], "s1");
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/sessions", { name: "brand new" });
      expect(res.status).toBe(201);
      expect(res.json.ok).toBe(true);
      const session = res.json.session as Record<string, unknown>;
      expect(typeof session.id).toBe("string");
      expect(session.name).toBe("brand new");
      expect(session.messageCount).toBe(1);
      expect(s.sessionManager?.get(String(session.id))?.name).toBe("brand new");
    });
  });

  it("POST /api/sessions accepts an empty body and defaults the name", async () => {
    const s = createWebUiState();
    s.sessionManager = fakeSessions([], null);
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/sessions", { method: "POST" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { session: Record<string, unknown> };
      expect(typeof body.session.id).toBe("string");
      expect(body.session.name).toBe("new");
    });
  });

  it("POST /api/sessions returns 503 without a manager", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/sessions", {});
      expect(res.status).toBe(503);
      expect(res.json.error).toBe("sessions_unavailable");
    });
  });

  it("GET /api/models returns knownModels()", async () => {
    const s = createWebUiState();
    s.knownModels = () => ["alpha", "beta"];
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/models");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ models: ["alpha", "beta"] });
    });
  });

  it("GET /api/models returns 503 when not wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      const res = await doFetch(base + "/api/models");
      expect(res.status).toBe(503);
    });
  });

  it("requires a token when one is configured", async () => {
    const s = createWebUiState();
    s.config = testConfig();
    s.token = "s3cret";
    await withServer(s, async (base) => {
      const denied = await doFetch(base + "/api/config");
      expect(denied.status).toBe(401);

      const allowed = await doFetch(base + "/api/config", {
        headers: { "x-mma-token": "s3cret" },
      });
      expect(allowed.status).toBe(200);
    });
  });
});
