import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { handleRequest } from "../src/modules/webui/server";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";
import { parseSetupAnswers, parseSecurityDetail } from "../src/modules/webui/settings/setup-api";
import { buildSetupDisplay, securityDetailFromConfig } from "../src/modules/setup/answers";
import { applySecurityDetail } from "../src/modules/setup/apply";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";
import { setLocale } from "../src/i18n/index";

const assets = {
  html: "<h1>hi</h1>",
  css: "body{}",
  js: "//ok",
  setupJs: "window.MmaSetup = {}; // /api/setup",
};

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

async function postJson(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await doFetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function virginState(): WebUiState {
  const s = createWebUiState();
  s.config = structuredClone(DEFAULTS);
  s.setupRequired = true;
  s.setup = buildSetupDisplay();
  return s;
}

function validAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai-compat",
    apiBase: "http://localhost:1234/v1",
    apiKey: "secret-key",
    model: "qwen/qwen3.5-9b",
    contextWindow: 32768,
    maxToolIterations: 1000,
    locale: "en",
    securityBashBlock: false,
    securityFlagsBlock: false,
    securityPathsRestrict: true,
    ...overrides,
  };
}

describe("parseSetupAnswers", () => {
  it("accepts a complete valid payload with defaults", () => {
    const a = parseSetupAnswers(validAnswers());
    expect(a).not.toBeNull();
    expect(a?.provider).toBe("openai-compat");
    expect(a?.contextWindow).toBe(32768);
    expect(a?.securityPathsRestrict).toBe(true);
  });

  it("coerces a missing/empty apiKey to not-needed", () => {
    const a = parseSetupAnswers(validAnswers({ apiKey: "" }));
    expect(a?.apiKey).toBe("not-needed");
  });

  it.each([
    ["no provider", { provider: "" }],
    ["no base url", { apiBase: "" }],
    ["no model", { model: "" }],
    ["bad context", { contextWindow: -1 }],
    ["bad non-integer", { contextWindow: 1.5 }],
    ["bad iterations", { maxToolIterations: "x" }],
    ["unknown locale", { locale: "de" }],
    ["missing flag", { securityBashBlock: undefined }],
    ["non-boolean flag", { securityFlagsBlock: "yes" }],
  ])("rejects %s", (_label, over) => {
    expect(parseSetupAnswers(validAnswers(over))).toBeNull();
  });
});

describe("security detail", () => {
  it("projects a live config to a JSON-safe detail (no RegExp patterns)", () => {
    const d = securityDetailFromConfig(DEFAULTS.security);
    expect(d.bash?.blacklist).toContain("rm");
    expect(d.paths?.denied).toContain(".env");
    expect(d.flags?.dangerousFlags).toContain("--force");
    expect(d.advanced?.maxRecursionDepth).toBe(3);
    // dangerousPatterns are RegExp and must not leak into the wire object.
    expect(JSON.stringify(d)).not.toContain("dangerousPatterns");
  });

  it("sanitizes lists (trims, drops empties, caps length) and rejects bad types", () => {
    const d = parseSecurityDetail({
      bash: { blacklist: ["  rm  ", "", "curl", 42, "x".repeat(500)], logCommands: "yes" },
      paths: { denied: ["a", "b"] },
      advanced: { maxRecursionDepth: -2, auditNotifierMinSeverity: "bogus" },
    });
    expect(d?.bash?.blacklist).toEqual(["rm", "curl"]);
    expect(d?.bash?.logCommands).toBeUndefined();
    expect(d?.paths?.denied).toEqual(["a", "b"]);
    expect(d?.advanced?.maxRecursionDepth).toBeUndefined();
    expect(d?.advanced?.auditNotifierMinSeverity).toBeUndefined();
  });

  it("ignores non-object detail", () => {
    expect(parseSecurityDetail(null)).toBeUndefined();
    expect(parseSecurityDetail("nope")).toBeUndefined();
    expect(parseSecurityDetail(42)).toBeUndefined();
  });

  it("applies only provided fields, leaving the rest of the config intact", () => {
    const security = structuredClone(DEFAULTS.security);
    applySecurityDetail(security, { paths: { denied: ["secret.md"] }, advanced: { maxRecursionDepth: 9 } });
    expect(security.paths.denied).toEqual(["secret.md"]);
    expect(security.maxRecursionDepth).toBe(9);
    // Untouched groups keep their defaults.
    expect(security.bash.blacklist).toContain("rm");
    expect(security.paths.allowed).toEqual([]);
  });
});

describe("webui setup REST", () => {
  // `/api/setup/locale` mutates the process-global i18n locale; restore it so
  // later tests in the shared worker still see English output.
  afterEach(() => setLocale("en"));

  it("GET /api/setup reports required + display data", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/setup`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        required: boolean;
        languages: Array<{ value: string }>;
        providers: Array<{ type: string; baseUrl?: string }>;
        defaults: {
          contextWindow: number;
          maxToolIterations: number;
          security?: { paths?: { denied?: string[] } };
        };
      };
      expect(body.required).toBe(true);
      expect(body.languages.map((l) => l.value)).toContain("ru");
      expect(body.providers.some((p) => p.type === "openai-compat")).toBe(true);
      expect(body.providers.find((p) => p.type === "openrouter")?.baseUrl).toContain("openrouter.ai");
      expect(body.defaults.contextWindow).toBe(32768);
      expect(body.defaults.maxToolIterations).toBe(1000);
      expect(body.defaults.security?.paths?.denied).toContain(".env");
    });
  });

  it("GET /api/setup reports required=false on a configured instance", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.setup = buildSetupDisplay();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/setup`);
      const body = (await res.json()) as { required: boolean };
      expect(body.required).toBe(false);
    });
  });

  it("POST /api/setup rejects an invalid payload without persisting", async () => {
    const s = virginState();
    let saved = 0;
    s.saveConfig = () => {
      saved++;
    };
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup", validAnswers({ contextWindow: 0 }));
      expect(res.status).toBe(400);
      expect(res.json.ok).toBe(false);
      expect(s.setupRequired).toBe(true);
      expect(saved).toBe(0);
    });
  });

  it("POST /api/setup applies, persists, reconfigures, flips the flag and broadcasts", async () => {
    const s = virginState();
    const saved: AppConfig[] = [];
    let reconfigured = 0;
    s.saveConfig = (cfg) => saved.push(cfg);
    s.reconfigure = () => {
      reconfigured++;
    };
    const events: string[] = [];
    s.clients.add({
      write: (chunk: string) => {
        events.push(chunk);
        return true;
      },
      end: () => {},
    } as unknown as ServerResponse);

    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup", validAnswers());
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.persisted).toBe(true);
      expect(res.json.warning).toBeUndefined();
      expect(s.setupRequired).toBe(false);
      expect(s.config?.model).toBe("qwen/qwen3.5-9b");
      expect(s.config?.provider.baseUrl).toBe("http://localhost:1234/v1");
      expect(s.config?.contextWindow).toBe(32768);
      expect(saved).toHaveLength(1);
      expect(reconfigured).toBe(1);
    });
    expect(events.join("")).toContain("setup_done");
  });

  it("POST /api/setup applies securityDetail from the popups", async () => {
    const s = virginState();
    s.saveConfig = () => {};
    s.reconfigure = () => {};
    await withServer(s, async (base) => {
      const res = await postJson(
        base,
        "/api/setup",
        validAnswers({
          securityDetail: {
            bash: { blacklist: ["rm", "mkfs"], logCommands: false },
            paths: { denied: ["only-this"] },
            advanced: { maxRecursionDepth: 7, auditNotifierEnabled: true },
          },
        }),
      );
      expect(res.status).toBe(200);
      expect(s.config?.security?.bash.blacklist).toEqual(["rm", "mkfs"]);
      expect(s.config?.security?.bash.logCommands).toBe(false);
      expect(s.config?.security?.paths.denied).toEqual(["only-this"]);
      expect(s.config?.security?.maxRecursionDepth).toBe(7);
      expect(s.config?.security?.auditNotifier.enabled).toBe(true);
      // Untouched: dangerousPatterns survives (RegExp, never sent over the wire).
      expect(Array.isArray(s.config?.security?.contentScan.dangerousPatterns)).toBe(true);
    });
  });

  it("POST /api/setup reports not-persisted when saveConfig throws", async () => {
    const s = virginState();
    s.saveConfig = () => {
      throw new Error("disk full");
    };
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup", validAnswers());
      expect(res.status).toBe(200);
      expect(res.json.persisted).toBe(false);
      expect(typeof res.json.warning).toBe("string");
      expect(s.setupRequired).toBe(false);
    });
  });

  it("POST /api/setup refuses to reconfigure a live instance (409)", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.setup = buildSetupDisplay();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup", validAnswers());
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("already_configured");
    });
  });

  it("POST /api/setup returns 503 without a config", async () => {
    const s = createWebUiState();
    s.setupRequired = true;
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup", validAnswers());
      expect(res.status).toBe(503);
    });
  });

  it("gates /api/message and /api/command with 409 setup_required", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const msg = await postJson(base, "/api/message", { text: "hi" });
      expect(msg.status).toBe(409);
      expect(msg.json.error).toBe("setup_required");

      const cmd = await postJson(base, "/api/command", { line: "/status" });
      expect(cmd.status).toBe(409);
      expect(cmd.json.error).toBe("setup_required");
    });
  });

  it("lets /api/setup/locale switch the process locale and returns dicts", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const bad = await postJson(base, "/api/setup/locale", { locale: "de" });
      expect(bad.status).toBe(400);

      const ok = await postJson(base, "/api/setup/locale", { locale: "ru" });
      expect(ok.status).toBe(200);
      const dicts = (ok.json.dicts ?? {}) as Record<string, Record<string, string>>;
      expect(dicts.ru["web.setup.title"]).toBeTruthy();
    });
  });

  it("POST /api/setup/models rejects a missing base URL", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup/models", {});
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid-base-url");
    });
  });

  it("POST /api/setup/context rejects a missing model", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup/context", {
        baseUrl: "http://127.0.0.1:1/v1",
      });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid-context-request");
    });
  });

  it("POST /api/setup/context fail-opens when the provider is unreachable", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/setup/context", {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "no-such-model",
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(false);
    });
  });

  it("still serves /api/state and static assets while gated", async () => {
    const s = virginState();
    await withServer(s, async (base) => {
      const state = await doFetch(`${base}/api/state`);
      expect(state.status).toBe(200);
      const js = await doFetch(`${base}/setup.js`);
      expect(js.status).toBe(200);
      expect(await js.text()).toContain("/api/setup");
    });
  });
});
