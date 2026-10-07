import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebUiState, } from "../src/modules/webui/state";
import { MemoryStore } from "../src/modules/memory/store";
import { DEFAULTS } from "../src/config/defaults";
import { withServer, postJson, doFetch, } from "./helpers/webui-server";
import { stubPlugins } from "./helpers/webui-plugins";




async function withMemory(fn: (store: MemoryStore, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "webui-settings-"));
  try {
    await fn(new MemoryStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("webui settings REST", () => {
  it("GET /api/memory groups entries by category and redacts secrets", async () => {
    await withMemory(async (store) => {
      store.append("facts", "plain fact");
      store.append("facts", "api_key=supersecretvalue1234567890");
      store.setPreference("name", "Alice");
      const s = createWebUiState();
      s.memory = store;

      await withServer(s, async (base) => {
        const res = await doFetch(`${base}/api/memory`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          preferences: Record<string, string>;
          categories: Array<{ name: string; entries: Array<{ n: number; text: string }> }>;
        };
        expect(body.preferences.name).toBe("Alice");
        const facts = body.categories.find((c) => c.name === "facts");
        expect(facts?.entries.map((e) => e.n)).toEqual([1, 2]);
        expect(facts?.entries[0].text).toContain("plain fact");
        expect(facts?.entries[1].text).not.toContain("supersecretvalue1234567890");
        // Categories without entries still appear (stable UI shape).
        expect(body.categories.map((c) => c.name)).toContain("decisions");
      });
    });
  });

  it("POST /api/memory appends an entry; invalid input is 400", async () => {
    await withMemory(async (store) => {
      const s = createWebUiState();
      s.memory = store;
      await withServer(s, async (base) => {
        const ok = await postJson(base, "/api/memory", { category: "decisions", text: "chose bun" });
        expect(ok.status).toBe(200);
        expect(ok.json.ok).toBe(true);
        expect(store.read("decisions")).toContain("chose bun");

        const badCat = await postJson(base, "/api/memory", { category: "nope", text: "x" });
        expect(badCat.status).toBe(400);

        const emptyText = await postJson(base, "/api/memory", { category: "facts", text: "   " });
        expect(emptyText.status).toBe(400);
      });
    });
  });

  it("DELETE /api/memory/:category/:n forgets the nth entry; unknown is 404", async () => {
    await withMemory(async (store) => {
      store.append("errors", "first");
      store.append("errors", "second");
      const s = createWebUiState();
      s.memory = store;
      await withServer(s, async (base) => {
        const del = await doFetch(`${base}/api/memory/errors/1`, { method: "DELETE" });
        expect(del.status).toBe(200);
        expect(store.read("errors")).not.toContain("first");
        expect(store.read("errors")).toContain("second");

        const missing = await doFetch(`${base}/api/memory/errors/9`, { method: "DELETE" });
        expect(missing.status).toBe(404);

        const badCat = await doFetch(`${base}/api/memory/bogus/1`, { method: "DELETE" });
        expect(badCat.status).toBe(400);
      });
    });
  });

  it("GET /api/skills lists skills with a loaded/enabled indicator", async () => {
    const s = createWebUiState();
    s.skills = {
      getAvailable: () => [
        { name: "alpha", description: "A", sourcePath: "/skills/alpha.md" },
        { name: "beta", sourcePath: "/skills/beta.md" },
      ],
      getLoaded: () => [{ name: "alpha" }],
    };
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/skills`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        skills: Array<{ name: string; source?: string; enabled?: boolean; description?: string }>;
      };
      const byName = new Map(body.skills.map((x) => [x.name, x]));
      expect(byName.get("alpha")?.enabled).toBe(true);
      expect(byName.get("alpha")?.source).toBe("/skills/alpha.md");
      expect(byName.get("alpha")?.description).toBe("A");
      expect(byName.get("beta")?.enabled).toBe(false);
    });
  });

  it("GET /api/plugins lists plugins and MCP servers from config", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.mcpServers = {
      context7: { name: "context7", url: "https://x", enabled: true },
      off: { name: "off", url: "https://y", enabled: false },
    };
    s.plugins = stubPlugins([
      {
        name: "builtin-a",
        version: "1.2.3",
        source: "builtin",
        builtin: true,
        enabled: true,
      },
      { name: "third-party", source: "global", builtin: false, enabled: false },
    ]);
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/plugins`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        plugins: Array<{ name: string; version?: string; source?: string; enabled?: boolean }>;
        failures: unknown[];
        mcp: Array<{ name: string; status: string }>;
      };
      expect(body.plugins.map((p) => p.name)).toEqual(["builtin-a", "third-party"]);
      expect(body.plugins[0].version).toBe("1.2.3");
      expect(body.plugins[0].source).toBe("builtin");
      // enabled больше не захардкожен `true` — приходит из реестра.
      expect(body.plugins.map((p) => p.enabled)).toEqual([true, false]);
      expect(body.failures).toEqual([]);
      const mcp = new Map(body.mcp.map((m) => [m.name, m.status]));
      expect(mcp.get("context7")).toBe("enabled");
      expect(mcp.get("off")).toBe("disabled");
    });
  });

  it("POST /api/mcp/:id toggles a configured server and persists", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.mcpServers = {
      context7: { name: "context7", url: "https://x", enabled: true },
    };
    const saved: number[] = [];
    s.saveConfig = () => {
      saved.push(1);
    };
    await withServer(s, async (base) => {
      const res = await postJson(base, "/api/mcp/context7", { enabled: false });
      expect(res.status).toBe(200);
      const body = res.json as {
        ok: boolean;
        persisted: boolean;
        restartRequired: boolean;
        mcp: Array<{ id: string; name: string; status: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.persisted).toBe(true);
      expect(body.restartRequired).toBe(true);
      expect(s.config?.mcpServers.context7.enabled).toBe(false);
      expect(body.mcp[0].status).toBe("disabled");
      expect(saved).toHaveLength(1);

      const missing = await postJson(base, "/api/mcp/ghost", { enabled: true });
      expect(missing.status).toBe(404);

      const bad = await postJson(base, "/api/mcp/context7", { enabled: "yes" });
      expect(bad.status).toBe(400);
    });
  });

  it("answers 503 when a collaborator is not wired", async () => {
    const s = createWebUiState();
    await withServer(s, async (base) => {
      expect((await doFetch(`${base}/api/memory`)).status).toBe(503);
      expect((await postJson(base, "/api/memory", { category: "facts", text: "x" })).status).toBe(503);
      expect((await doFetch(`${base}/api/memory/facts/1`, { method: "DELETE" })).status).toBe(503);
      expect((await doFetch(`${base}/api/skills`)).status).toBe(503);
      expect((await doFetch(`${base}/api/plugins`)).status).toBe(503);
    });
  });

  it("requires a token when one is configured", async () => {
    await withMemory(async (store) => {
      const s = createWebUiState();
      s.memory = store;
      s.token = "s3cret";
      await withServer(s, async (base) => {
        expect((await doFetch(`${base}/api/memory`)).status).toBe(401);
        const allowed = await doFetch(`${base}/api/memory`, {
          headers: { "x-mma-token": "s3cret" },
        });
        expect(allowed.status).toBe(200);
      });
    });
  });
});
