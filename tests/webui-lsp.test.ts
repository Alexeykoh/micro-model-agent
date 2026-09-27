import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config/defaults";
import { createWebUiState } from "../src/modules/webui/state";
import { withServer, doFetch } from "./helpers/webui-server";

describe("lsp read/edit", () => {
  it("lists default servers", async () => {
    const mod = await import("../src/modules/webui/settings-api");
    expect(typeof (mod as Record<string, unknown>).listLspServers).toBe("function");
    const cfg = structuredClone(DEFAULTS);
    const list = (
      mod as { listLspServers: (c: unknown) => Array<{ lang: string }> }
    ).listLspServers(cfg);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty("lang");
  });

  it("GET /api/lsp serves the table; PUT edits one server", async () => {
    const s = createWebUiState();
    s.config = structuredClone(DEFAULTS);
    s.saveConfig = () => {};
    await withServer(s, async (base) => {
      const res = await doFetch(`${base}/api/lsp`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        servers: Array<{ lang: string; command: string; timeout: number; enabled: boolean }>;
      };
      expect(body.servers.length).toBeGreaterThan(0);
      const ts = body.servers.find((x) => x.lang === "typescript");
      expect(ts?.command).toBe("npx");

      const updated = await doFetch(`${base}/api/lsp/typescript`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, timeout: 20000 }),
      });
      expect(updated.status).toBe(200);
      const ubody = (await updated.json()) as { ok: boolean; restartRequired: boolean };
      expect(ubody.ok).toBe(true);
      expect(ubody.restartRequired).toBe(true);

      const ghost = await doFetch(`${base}/api/lsp/cobol`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(ghost.status).toBe(404);
    });
  });
});
