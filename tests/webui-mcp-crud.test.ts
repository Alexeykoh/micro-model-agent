import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, postJson, doFetch } from "./helpers/webui-server";

describe("mcp crud", () => {
  it("validates create input", async () => {
    const mod = await import("../src/modules/webui/settings-api");
    expect(typeof (mod as Record<string, unknown>).createMcpServer).toBe("function");
    const cfg = structuredClone(DEFAULTS);
    const bad = (
      mod as { createMcpServer: (c: unknown, i: unknown) => { ok: boolean } }
    ).createMcpServer(cfg, { name: "x", transport: "http" });
    expect(bad.ok).toBe(false); // missing url
  });

  it("CRUD over HTTP masks secrets and flags restart", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.config.mcpServers = {};
    s.saveConfig = () => {};
    s.plugins = { getPluginInfos: () => [] };
    await withServer(s, async (base) => {
      const created = await postJson(base, "/api/mcp", {
        name: "srv",
        transport: "stdio",
        command: "npx",
        env: { TOKEN: "supersecretvalue1234567890" },
        headers: { Authorization: "Bearer abcdef1234567890" },
      });
      expect(created.status).toBe(200);
      expect(created.json.ok).toBe(true);
      expect(created.json.restartRequired).toBe(true);
      expect(JSON.stringify(created.json)).not.toContain("supersecretvalue1234567890");
      expect(JSON.stringify(created.json)).not.toContain("abcdef1234567890");

      const plugins = await doFetch(`${base}/api/plugins`);
      expect(plugins.status).toBe(200);
      const body = (await plugins.json()) as {
        mcp: Array<{ id: string; envKeys: string[]; headerKeys: string[] }>;
      };
      expect(body.mcp[0].envKeys).toEqual(["TOKEN"]);
      expect(body.mcp[0].headerKeys).toEqual(["Authorization"]);
      expect(JSON.stringify(body)).not.toContain("supersecretvalue1234567890");

      const dupe = await postJson(base, "/api/mcp", { name: "srv", command: "x" });
      expect(dupe.status).toBe(400);

      const updated = await doFetch(`${base}/api/mcp/srv`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeout: 5000 }),
      });
      expect(updated.status).toBe(200);
      expect(s.config?.mcpServers.srv.timeout).toBe(5000);

      const badTimeout = await doFetch(`${base}/api/mcp/srv`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeout: 5 }),
      });
      expect(badTimeout.status).toBe(400);

      const ghost = await doFetch(`${base}/api/mcp/ghost`, { method: "DELETE" });
      expect(ghost.status).toBe(404);

      const deleted = await doFetch(`${base}/api/mcp/srv`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(s.config?.mcpServers.srv).toBeUndefined();
    });
  });
});
