// REST подстраниц настроек плагинов: GET/PUT .../settings, 404/400/503.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config/defaults";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";
import { withServer, doFetch } from "./helpers/webui-server";
import { stubPlugins } from "./helpers/webui-plugins";
import type { AgentPlugin } from "../src/modules/types";

function pluginEntry(dir: string, name: string): string {
  const entry = join(dir, name, "plugin.ts");
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(entry, "export default {}", "utf8");
  return entry;
}

function stateWithPlugins(plugins: AgentPlugin[]): WebUiState {
  const dir = mkdtempSync(join(tmpdir(), "mma-psettings-"));
  const withPaths = plugins.map((p) => ({ ...p, path: p.path ?? pluginEntry(dir, p.name) }));
  const s = createWebUiState();
  s.config = structuredClone(DEFAULTS);
  s.config.plugins = { ...s.config.plugins, disabled: [] };
  const stub = stubPlugins(
    withPaths.map((p) => ({
      name: p.name,
      source: "project" as const,
      hasSettings: (p.settingsSchema ?? []).length > 0,
    })),
  );
  s.plugins = {
    ...stub,
    getPlugin: (name: string) => withPaths.find((p) => p.name === name) ?? null,
  };
  s.saveConfig = () => {};
  return s;
}

async function putJson(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await doFetch(base + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const SCHEMA_PLUGIN: AgentPlugin = {
  name: "greeter",
  settingsSchema: [
    { key: "greeting", type: "string", title: "Greeting", default: "hi" },
    { key: "retries", type: "number", min: 1, max: 9 },
    { key: "token", type: "string", secret: true },
  ],
};

describe("plugin settings REST", () => {
  it("GET returns schema with defaults for a fresh plugin", async () => {
    const s = stateWithPlugins([SCHEMA_PLUGIN]);
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/plugins/greeter/settings`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        schema: Array<{ key: string }>;
        values: Record<string, unknown>;
        hasSecrets: string[];
      };
      expect(body.ok).toBe(true);
      expect(body.schema.map((d) => d.key)).toEqual(["greeting", "retries", "token"]);
      expect(body.values).toMatchObject({ greeting: "hi", token: "" });
      expect(body.hasSecrets).toEqual([]);
    });
  });

  it("PUT persists values and GET reads them back", async () => {
    const s = stateWithPlugins([SCHEMA_PLUGIN]);
    await withServer(s, async (base) => {
      const put = await putJson(base, "/api/plugins/greeter/settings", {
        values: { greeting: "yo", retries: 3 },
      });
      expect(put.status).toBe(200);
      expect(put.json).toMatchObject({ ok: true, values: { greeting: "yo", retries: 3 } });
      const get = await (await doFetch(`${base}/api/plugins/greeter/settings`)).json() as {
        values: Record<string, unknown>;
      };
      expect(get.values).toMatchObject({ greeting: "yo", retries: 3 });
    });
  });

  it("PUT rejects unknown keys and invalid values with 400", async () => {
    const s = stateWithPlugins([SCHEMA_PLUGIN]);
    await withServer(s, async (base) => {
      const unknown = await putJson(base, "/api/plugins/greeter/settings", {
        values: { ghost: 1 },
      });
      expect(unknown.status).toBe(400);
      expect(String(unknown.json.error)).toContain("unknown-key");
      const invalid = await putJson(base, "/api/plugins/greeter/settings", {
        values: { retries: 99 },
      });
      expect(invalid.status).toBe(400);
      expect(String(invalid.json.error)).toContain("invalid-value");
      const noBody = await putJson(base, "/api/plugins/greeter/settings", { nope: 1 });
      expect(noBody.status).toBe(400);
    });
  });

  it("GET answers 404 for unknown plugins and plugins without settings", async () => {
    const s = stateWithPlugins([SCHEMA_PLUGIN, { name: "plain" }]);
    await withServer(s, async (base) => {
      const ghost = await doFetch(`${base}/api/plugins/ghost/settings`);
      expect(ghost.status).toBe(404);
      expect(((await ghost.json()) as { error: string }).error).toBe("not_found");
      const plain = await doFetch(`${base}/api/plugins/plain/settings`);
      expect(plain.status).toBe(404);
      expect(((await plain.json()) as { error: string }).error).toBe("no_settings");
    });
  });

  it("answers 503 when the plugin manager is missing", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    await withServer(s, async (base) => {
      const get = await doFetch(`${base}/api/plugins/greeter/settings`);
      expect(get.status).toBe(503);
      const put = await putJson(base, "/api/plugins/greeter/settings", { values: {} });
      expect(put.status).toBe(503);
    });
  });
});
