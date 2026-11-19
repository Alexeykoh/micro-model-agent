/**
 * Shared HTTP harness for `webui-*.test.ts` (rule: one test harness).
 *
 * Every webui REST test used to copy the same `assets`/`doFetch`/`withServer`/
 * `postJson` scaffolding (~13 files). Import from here instead.
 */
import { createServer } from "node:http";
import { handleRequest } from "../../src/modules/webui/server";
import type { WebUiAssets, WebUiState } from "../../src/modules/webui/state";

/** Minimal static assets served by the test server. */
export const webuiAssets: WebUiAssets = { html: "<h1>hi</h1>", css: "body{}", js: "//ok" };

// Other tests in the shared process may stub globalThis.fetch; use the runtime's
// own fetch so HTTP assertions stay real.
export const doFetch: typeof fetch =
  typeof Bun !== "undefined" ? (Bun as unknown as { fetch: typeof fetch }).fetch.bind(Bun) : fetch;

/** Start an ephemeral server over `s`, run `fn(base)`, then close it. */
export async function withServer(
  s: WebUiState,
  fn: (base: string) => Promise<void>,
  assets: WebUiAssets = webuiAssets,
): Promise<void> {
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

/** POST JSON and read the parsed JSON body back. */
export async function postJson(
  base: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await doFetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
