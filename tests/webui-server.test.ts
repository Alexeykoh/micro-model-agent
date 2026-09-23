import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { handleRequest, startServer, stopServer } from "../src/modules/webui/server";
import { createWebUiState } from "../src/modules/webui/state";

const assets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

function get(url: string): Promise<{ status: number; body: string }> {
  return fetch(url).then(async (r) => ({ status: r.status, body: await r.text() }));
}

describe("webui server", () => {
  afterEach(() => stopServer());

  it("serves static assets", async () => {
    const url = await startServer(assets);
    const page = await get(url + "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("hi");
    const js = await get(url + "/app.js");
    expect(js.body).toBe("//ok");
  });

  it("404s unknown paths", async () => {
    const url = await startServer(assets);
    expect((await get(url + "/nope")).status).toBe(404);
  });

  it("handleRequest works against an explicit state (app≠listen)", async () => {
    const s = createWebUiState();
    const srv = createServer((req, res) => handleRequest(req, res, assets, s));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    srv.close();
  });
});
