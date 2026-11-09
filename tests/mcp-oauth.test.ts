import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { oauthHeaders, refreshToken, resolveTokenFile } from "../src/modules/mcp/oauth";

describe("MCP OAuth token provider", () => {
  it("resolveTokenFile resolves relative to baseDir", () => {
    const rel = resolveTokenFile({ oauth: { tokenFile: "tok.json" } }, "/proj")!;
    expect(rel.endsWith("tok.json")).toBe(true);
    expect(resolveTokenFile({ oauth: { tokenFile: "/abs/tok.json" } }, "/proj")).toBe("/abs/tok.json");
  });

  it("no oauth → no headers", async () => {
    await expect(oauthHeaders({})).resolves.toEqual({});
  });

  it("serves fresh token before expiry from tokenFile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-oauth-"));
    const path = join(dir, "tok.json");
    writeFileSync(path, JSON.stringify({ access: "tok", expiresAt: new Date(Date.now() + 3600000).toISOString() }), "utf-8");
    const headers = await oauthHeaders({ oauth: { tokenUrl: "https://idp/token", tokenFile: path } });
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("refreshes expired token over fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-oauth-"));
    const path = join(dir, "tok.json");
    writeFileSync(
      path,
      JSON.stringify({ access: "old", refreshToken: "rt", expiresAt: new Date(Date.now() - 1000).toISOString() }),
      "utf-8",
    );
    const origFetch = globalThis.fetch;
    let seenBody = "";
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url, init) => {
      seenBody = String((init as { body: URLSearchParams }).body);
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    try {
      const fresh = await refreshToken(path, "https://idp/token", "client");
      expect(fresh).toBe("new");
      expect(seenBody).toContain("refresh_token=rt");
      const stored = JSON.parse(readFileSync(path, "utf-8")) as { access: string };
      expect(stored.access).toBe("new");
    } finally {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
    }
  });
});
