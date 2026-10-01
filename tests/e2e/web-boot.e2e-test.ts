/**
 * Playwright e2e: basic boot smoke for `mma web`.
 *
 * Guards the "blank page shipped to npm" class of failures: a syntax error
 * in ANY frontend module (e.g. the stray `}` in `settings.js` that pushed
 * `return` to top level and shipped in 2.15.0) breaks the whole `app.js`
 * import graph — the page boots with an `Uncaught SyntaxError` pageerror,
 * no feed, no session tab, selectors stuck at "–".
 *
 * Both tests fail loudly on that regression:
 * - the browser test collects console/page errors and asserts the chrome
 *   actually boots (feed + live tab + settings modal);
 * - the asset test fetches every served JS module over HTTP (routes
 *   discovered from the live `/app.js` import graph, not hardcoded).
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 */
import { describe, expect } from "vitest";
import { startE2EServer, stopE2EServer, artifactsDirFor } from "./web-harness";
import {
  e2e,
  withE2E,
  waitForLiveTab,
  writeArtifacts,
  type Launched,
} from "./web-helpers";

/** `./js/<name>.js` targets imported by a served module source. */
function jsImports(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/from\s+["'](\.\/js\/[\w-]+\.js)["']/g)) found.add(m[1].slice(2));
  return [...found];
}

async function getOk(baseUrl: string, path: string): Promise<string> {
  const res = await fetch(`${baseUrl}${path}`);
  if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status}`);
  const body = await res.text();
  if (body.length < 100) throw new Error(`GET ${path} answered 200 with a stub body`);
  return body;
}

/** GET every module reachable from `entries` via relative `./js/*.js` imports. */
async function fetchImportGraph(baseUrl: string, entries: string[]): Promise<string[]> {
  const seen = new Set<string>(entries);
  const fetched: string[] = [];
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    const src = await getOk(baseUrl, path);
    fetched.push(path);
    for (const name of jsImports(src)) {
      const dep = `/${name}`;
      if (!seen.has(dep)) {
        seen.add(dep);
        pending.push(dep);
      }
    }
  }
  return fetched;
}

describe("web e2e: boot smoke", () => {
  e2e(
    "boots with zero console/page errors and a live session tab",
    async () => {
      const dir = artifactsDirFor("boot-smoke");
      await withE2E(dir, async (_srv, { page, errors }: Launched) => {
        // SSE + state pipeline alive: the server auto-opened a session tab.
        await waitForLiveTab(page);

        // Chrome skeleton rendered — not a dead blank page.
        await expect.poll(() => page.locator("#newChat").count()).toBeGreaterThan(0);
        await expect.poll(() => page.locator("#openSettings").count()).toBeGreaterThan(0);
        await expect.poll(() => page.locator("#inp").count()).toBeGreaterThan(0);
        await expect.poll(() => page.locator(".sb-tab").count()).toBeGreaterThan(0);
        await expect
          .poll(() => page.locator("#msgs .empty, #msgs .feed").count())
          .toBeGreaterThan(0);

        // Settings modal opens and the general panel is non-empty
        // (settings.js is the module that broke the boot in 2.15.0).
        await page.click("#openSettings");
        await page.waitForSelector("#overlay.open", { timeout: 10_000 });
        await expect
          .poll(() => page.locator('[data-panel="general"]').innerText(), { timeout: 10_000 })
          .not.toHaveLength(0);
        await page.screenshot({ path: `${dir}/boot-smoke.png` });

        writeArtifacts(dir, "boot-smoke", {
          html: await page.content(),
          consoleErrors: errors,
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );

  e2e(
    "serves every frontend js module in the app.js import graph",
    async () => {
      const dir = artifactsDirFor("boot-assets");
      const srv = await startE2EServer({ artifactsDir: dir });
      try {
        const entries = ["/app.js", "/setup.js", "/md.js", "/smd.js", "/hljs.js", "/styles.css"];
        // Modules reachable from the entries (covers settings.js and the whole
        // js/ graph: feed/tabs/dialog/rail/sidebar/… import each other).
        const fetched = await fetchImportGraph(srv.baseUrl, entries);
        // The graph is the point: a hardcoded list would silently miss modules.
        expect(fetched.length).toBeGreaterThan(entries.length);
        writeArtifacts(dir, "boot-assets", {
          consoleErrors: [],
          extra: { fetched },
        });
      } finally {
        await stopE2EServer(srv);
      }
    },
    180_000,
  );
});
