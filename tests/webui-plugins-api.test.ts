// REST вкладки Plugins: форма `GET /api/plugins` и живой тумблер `POST /api/plugins/:name`.
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";
import { withServer, postJson, doFetch } from "./helpers/webui-server";
import { stubPlugins } from "./helpers/webui-plugins";

function makeState(overrides?: Partial<ReturnType<typeof stubPlugins>>): WebUiState {
  const s = createWebUiState();
  s.config = structuredClone(DEFAULTS);
  // Фикстура изолирована от засева `DEFAULTS.plugins.disabled` (там `angular11`).
  s.config.plugins = { ...s.config.plugins, disabled: [] };
  s.plugins = { ...stubPlugins([]), ...overrides };
  let saved = 0;
  s.saveConfig = () => {
    saved++;
  };
  s.__saved = () => saved;
  return s;
}

describe("webui plugins REST", () => {
  it("GET returns full records with a real enabled flag", async () => {
    const s = makeState({
      getRecords: () => [
        {
          name: "my-plugin",
          version: "1.2.3",
          author: "alexe",
          description: "does a thing",
          homepage: "https://example.com",
          source: "project",
          builtin: false,
          draft: false,
          enabled: false,
          path: "/p/.mma/plugins/my-plugin/plugin.ts",
          provides: { tools: ["foo_run"], hooks: ["onToolEnd"] },
          permissions: ["fs:read", "process"],
          warnings: ["author is empty"],
        },
      ],
      getFailures: () => [],
      setEnabled: () => true,
    });
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/plugins`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plugins: Array<Record<string, unknown>>; failures: unknown[] };
      expect(body.plugins).toHaveLength(1);
      const p = body.plugins[0];
      expect(p).toMatchObject({
        name: "my-plugin",
        version: "1.2.3",
        author: "alexe",
        description: "does a thing",
        enabled: false,
        builtin: false,
        draft: false,
        source: "project",
      });
      expect(p.permissions).toEqual(["fs:read", "process"]);
      expect(p.provides).toEqual({ tools: ["foo_run"], hooks: ["onToolEnd"] });
      expect(p.warnings).toEqual(["author is empty"]);
      expect(body.failures).toEqual([]);
    });
  });

  it("GET surfaces load failures (a broken plugin used to vanish)", async () => {
    const s = makeState({
      getFailures: () => [
        { entry: "broken/plugin.ts", path: "/p/broken/plugin.ts", message: "Unexpected token", at: 1 },
      ],
    });
    await withServer(s, async (base) => {
      const body = (await (await doFetch(`${base}/api/plugins`)).json()) as {
        failures: Array<{ entry: string; message: string }>;
      };
      expect(body.failures).toHaveLength(1);
      expect(body.failures[0].entry).toBe("broken/plugin.ts");
    });
  });

  it("POST toggles a plugin, writes the deny-list and returns fresh records", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.plugins = { ...s.config.plugins, disabled: [] };
    s.plugins = stubPlugins([
      { name: "a", source: "project" },
      { name: "b", source: "project" },
    ]);
    let saved = 0;
    s.saveConfig = () => {
      saved++;
    };
    await withServer(s, async (base) => {
      const off = await postJson(base, "/api/plugins/a", { enabled: false });
      expect(off.status).toBe(200);
      expect(off.json.ok).toBe(true);
      expect(off.json.persisted).toBe(true);
      expect(s.config.plugins?.disabled).toEqual(["a"]);
      const records = off.json.plugins as Array<{ name: string; enabled: boolean }>;
      expect(records.find((r) => r.name === "a")?.enabled).toBe(false);
      expect(records.find((r) => r.name === "b")?.enabled).toBe(true);
      // нет restartRequired: эффект живой
      expect(off.json.restartRequired).toBeUndefined();

      const on = await postJson(base, "/api/plugins/a", { enabled: true });
      expect(on.status).toBe(200);
      expect(s.config.plugins?.disabled).toEqual([]);
      expect(saved).toBe(2);
    });
  });

  it("POST keeps unrelated deny-list entries intact", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.plugins = { disabled: ["b"] };
    s.plugins = stubPlugins([{ name: "a" }, { name: "b" }]);
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      await postJson(base, "/api/plugins/a", { enabled: false });
      expect(s.config.plugins?.disabled?.sort()).toEqual(["a", "b"]);
      await postJson(base, "/api/plugins/b", { enabled: true });
      expect(s.config.plugins?.disabled).toEqual(["a"]);
    });
  });

  it("POST rejects a non-boolean enabled with 400", async () => {
    const s = makeState({ getRecords: () => [{ name: "a" } as never] });
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/plugins/a", { enabled: "yes" });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("invalid-enabled");
    });
  });

  it("POST rejects invalid JSON with 400", async () => {
    const s = makeState();
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/plugins/a`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });
  });

  it("POST answers 404 for an unknown plugin", async () => {
    const s = makeState();
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/plugins/ghost", { enabled: false });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe("not_found");
      expect(s.config.plugins?.disabled).toEqual([]);
    });
  });

  it("GET answers 503 when no plugin manager is wired", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/plugins`);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("plugins_unavailable");
    });
  });

  it("POST answers 503 when the plugin manager is missing", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/plugins/a", { enabled: false });
      expect(res.status).toBe(503);
      expect(res.json.error).toBe("plugins_unavailable");
    });
  });

  it("POST answers 503 when config is unavailable", async () => {
    const s = createWebUiState();
    s.plugins = stubPlugins([{ name: "a" }]);
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/plugins/a", { enabled: false });
      expect(res.status).toBe(503);
      expect(res.json.error).toBe("config_unavailable");
    });
  });

  it("url-encoded names survive the round trip", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.plugins = { ...s.config.plugins, disabled: [] };
    s.plugins = stubPlugins([{ name: "my.plugin-2" }]);
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/plugins/my.plugin-2", { enabled: false });
      expect(res.status).toBe(200);
      expect(s.config.plugins?.disabled).toEqual(["my.plugin-2"]);
    });
  });

  it("POST /api/reload/plugins returns the reload counts and broadcasts", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.plugins = stubPlugins([{ name: "a" }, { name: "b" }]);
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/reload/plugins");
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      const reload = res.json.reload as { plugins: { loaded: number }; skills: unknown };
      expect(reload.plugins.loaded).toBe(2);
      expect(res.json.plugins).toHaveLength(2);
    });
  });

  it("POST /api/reload/plugins answers 503 without a plugin manager", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/reload/plugins");
      expect(res.status).toBe(503);
      expect(res.json.error).toBe("plugins_unavailable");
    });
  });

  it("a plugin named 'reload' stays toggleable (action namespace is separate)", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.plugins = { ...s.config.plugins, disabled: [] };
    s.plugins = stubPlugins([{ name: "reload" }]);
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/plugins/reload", { enabled: false });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(s.config.plugins?.disabled).toEqual(["reload"]);
    });
  });
});

declare module "../src/modules/webui/state" {
  interface WebUiState {
    __saved?: () => number;
  }
}
