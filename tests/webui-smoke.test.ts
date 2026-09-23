import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { startServer, stopServer } from "../src/modules/webui/server";
import { loadAssets } from "../src/modules/webui/assets";
import { createWebUiState, type WebUiState } from "../src/modules/webui/state";
import { DEFAULTS } from "../src/config/defaults";
import { MemoryStore } from "../src/modules/memory/store";
import type { Host } from "../src/core/host";

/**
 * Headless smoke for the served web UI. Starts the real HTTP server with the
 * real `loadAssets()` and loads `/` in Chromium, asserting the chrome renders
 * and the page logs no errors.
 *
 * The suite skips gracefully when no browser is usable: no discoverable
 * Chromium executable, or Bun (Playwright's pipe transport hangs under Bun —
 * see `src/modules/browser/driver.ts`, which routes through a Node bridge).
 * So CI without browsers, and the repo's own `bun test`, pass.
 */
function isMissingBrowserError(err: unknown): boolean {
  return /Executable doesn't exist|is not found|looks like Playwright was just installed/i.test(
    String((err as { message?: string } | null)?.message ?? err),
  );
}

/** Bundled revision or `MMA_BROWSER_EXECUTABLE`, only if it actually exists. */
function discoverChromium(): string | null {
  const env = process.env.MMA_BROWSER_EXECUTABLE?.trim();
  if (env && existsSync(env)) return env;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // No bundled revision resolvable — treat as "no browser".
  }
  return null;
}

const CHROMIUM = discoverChromium();
const CAN_RUN = CHROMIUM !== null && !process.versions.bun;
// Static skip keeps Bun (whose dynamic `ctx.skip()` hangs) out of the body
// entirely; the body's dynamic skip only ever runs under Node's vitest.
const smoke = CAN_RUN ? it : it.skip;

/** Wire enough collaborators that every boot request answers 200. */
function makeState(): { state: WebUiState; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "webui-smoke-"));
  const state = createWebUiState();
  state.config = structuredClone(DEFAULTS);
  state.knownModels = () => [];
  state.memory = new MemoryStore(dir);
  state.skills = { getAvailable: () => [], getLoaded: () => [] };
  state.plugins = { getPluginInfos: () => [] };
  state.sessionManager = {
    list: () => [],
    get: () => null,
    getActive: () => null,
    setActive: () => {},
    delete: () => {},
  };
  const bridge: Host = {
    isBusy: () => false,
    submit: () => Promise.resolve(),
    interrupt: () => {},
    getState: () => ({ busy: false }),
    executeCommand: () => Promise.resolve(),
  };
  state.bridge = bridge;
  return { state, dir };
}

describe("webui smoke", () => {
  smoke(
    "serves the page with topbar + settings and no console errors",
    async (ctx) => {
      const { state, dir } = makeState();
      let browser: Browser | null = null;
      let started = false;
      try {
        const url = await startServer(loadAssets(), state);
        started = true;

        try {
          browser = await chromium.launch({
            headless: true,
            executablePath: CHROMIUM ?? undefined,
            timeout: 15_000,
          });
        } catch (err) {
          if (isMissingBrowserError(err)) {
            ctx.skip();
            return;
          }
          throw err;
        }

        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") errors.push(msg.text());
        });
        page.on("pageerror", (err) => errors.push(err.message));

        await page.goto(url + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
        await page.waitForSelector(".bar-top", { timeout: 5_000 });
        await page.waitForSelector("#openSettings", { timeout: 5_000 });

        await page.click("#openSettings");
        await page.waitForSelector("#overlay.open", { timeout: 5_000 });

        expect(await page.locator(".bar-top").count()).toBe(1);
        expect(await page.locator("#openSettings").count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        if (browser) await browser.close().catch(() => {});
        if (started) stopServer(state);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
