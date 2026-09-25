import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
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

        // Composer: attach + textarea + send on one row, Esc hint idle-hidden.
        expect(await page.locator(".composer .attach-btn").count()).toBe(1);
        expect(await page.locator(".composer #inp").count()).toBe(1);
        expect(await page.locator(".composer #sendBtn").count()).toBe(1);
        expect(await page.locator("#hintEsc").isHidden()).toBe(true);

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

  smoke(
    "renders a named session tab with the full session id once a session is active",
    async (ctx) => {
      const { state, dir } = makeState();
      state.bridge = {
        isBusy: () => false,
        submit: () => Promise.resolve(),
        interrupt: () => {},
        getState: () => ({ busy: false, sessionId: "abcd1234", sessionName: "My session" }),
        executeCommand: () => Promise.resolve(),
      };
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
        await page.goto(url + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
        await page.waitForSelector(".stab", { timeout: 5_000 });

        expect(await page.locator(".stab").count()).toBe(1);
        expect(await page.locator(".stab .name").innerText()).toBe("My session");
        expect(await page.locator(".stab .sid").innerText()).toBe("abcd1234");

        const box = await page.locator(".stab").first().boundingBox();
        expect(box).not.toBeNull();
        expect(box?.height ?? 0).toBeGreaterThan(15);

        // Slash-command autocomplete: '/' opens the menu, Tab completes.
        await page.click("#inp");
        await page.type("#inp", "/mo");
        await page.waitForSelector(".cmdk .cmdk-item", { timeout: 5_000 });
        const cmdItems = await page.locator(".cmdk .cmdk-item").allInnerTexts();
        expect(cmdItems.length).toBeGreaterThan(0);
        expect(cmdItems.every((t) => t.startsWith("/mo"))).toBe(true);
        await page.keyboard.press("Tab");
        expect(await page.inputValue("#inp")).toBe("/model ");
      } finally {
        if (browser) await browser.close().catch(() => {});
        if (started) stopServer(state);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // Regression guard: long/unbreakable feed content and long menu labels must
  // not create horizontal scroll — neither in the feed (`#msgs`) nor at the
  // page level (which would shove the sidebar off-screen).
  smoke(
    "no horizontal overflow from long content or long menu labels",
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

        for (const width of [1440, 1000, 820]) {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          await page.goto(url + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
          await page.waitForSelector("#inp", { timeout: 5_000 });

          const report = await page.evaluate(() => {
            const msgs = document.querySelector("#msgs") as HTMLElement;
            const long = "x".repeat(400);
            const mk = (cls: string, html: string) => {
              const d = document.createElement("div");
              d.className = cls;
              d.innerHTML = html;
              msgs.appendChild(d);
            };
            mk("ans", long);
            mk("u", long);
            mk("code", long);
            mk("detail", "↳ " + long);
            mk("cmdout", long);
            mk("filecard", `<span class="g">◇</span><span class="name">${long}</span><span class="meta">view</span>`);
            mk("linkline", `↳ <a href="#">https://example.com/${long}</a>`);
            const act = document.createElement("div");
            act.className = "act recon";
            act.innerHTML = `<span class="g">◇</span><span class="lab">Reading file</span><span class="sep">·</span><span class="args">${long}</span><span class="ok">✓</span>`;
            msgs.appendChild(act);

            // Open the model selector with long labels (real markup: a span child).
            (document.querySelector("#selModelBtn") as HTMLElement).click();
            const menu = document.querySelector("#selModelMenu") as HTMLElement;
            for (let i = 0; i < 4; i++) {
              const b = document.createElement("button");
              b.className = "mi";
              const s = document.createElement("span");
              s.textContent = "model-" + "abcdefghij".repeat(20) + i;
              b.appendChild(s);
              menu.appendChild(b);
            }
            document.querySelector('[data-sel="model"]')?.classList.add("open");

            const de = document.documentElement;
            const offenders: string[] = [];
            msgs.querySelectorAll("*").forEach((el) => {
              const e = el as HTMLElement;
              if (e.getBoundingClientRect().width > msgs.clientWidth + 1) {
                offenders.push(`${e.tagName}.${String(e.className).slice(0, 40)}`);
              }
            });
            return {
              docScroll: de.scrollWidth,
              docClient: de.clientWidth,
              msgsScroll: msgs.scrollWidth,
              msgsClient: msgs.clientWidth,
              offenders,
            };
          });

          const msg = `w=${width} ${JSON.stringify(report)}`;
          expect(report.offenders, msg).toEqual([]);
          expect(report.msgsScroll, msg).toBeLessThanOrEqual(report.msgsClient);
          expect(report.docScroll, msg).toBeLessThanOrEqual(report.docClient);
          await page.close();
        }
      } finally {
        if (browser) await browser.close().catch(() => {});
        if (started) stopServer(state);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // Session delete: a confirmation dialog guards the destructive action; the
  // active session has no delete control at all (server would 409 anyway).
  smoke(
    "session delete confirms and hides the control for the active session",
    async (ctx) => {
      const { state, dir } = makeState();
      const now = new Date().toISOString();
      const deleted: string[] = [];
      state.sessionManager = {
        list: () => [
          { id: "aaaa1111", name: "Active", updatedAt: now },
          { id: "bbbb2222", name: "Other", updatedAt: now },
        ],
        get: (id: string) => ({ id, name: id, updatedAt: now }),
        getActive: () => "aaaa1111",
        setActive: () => {},
        delete: (id: string) => {
          deleted.push(id);
        },
      } as unknown as NonNullable<typeof state.sessionManager>;
      state.bridge = {
        isBusy: () => false,
        submit: () => Promise.resolve(),
        interrupt: () => {},
        getState: () => ({ busy: false, sessionId: "aaaa1111", sessionName: "Active" }),
        executeCommand: () => Promise.resolve(),
      };
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
        await page.goto(url + "/", { waitUntil: "domcontentloaded", timeout: 10_000 });
        await page.waitForSelector("#sessBtn", { timeout: 5_000 });
        await page.click("#sessBtn");
        await page.waitForSelector(".dd-menu .si-row.on", { timeout: 5_000 });

        // The full session id is shown in the tab and in the list (not truncated).
        expect(await page.locator(".stab .sid").first().innerText()).toBe("aaaa1111");
        expect(await page.locator("#sessActiveList .si-row .id").innerText()).toBe("aaaa1111");

        // The active session has no delete control; only the other session does.
        expect(await page.locator("#sessActiveList .del-btn").count()).toBe(0);
        const dels = page.locator(".dd-menu .del-btn");
        expect(await dels.count()).toBe(1);

        // Clicking delete opens a confirmation dialog; cancelling is non-destructive.
        await dels.first().click();
        await page.waitForSelector("#confirmOverlay.open", { timeout: 5_000 });
        await page.click("#confirmCancel");
        await page.waitForSelector("#confirmOverlay.open", { state: "hidden", timeout: 5_000 });
        expect(deleted).not.toContain("bbbb2222");

        // Confirming deletes the non-active session.
        await dels.first().click();
        await page.waitForSelector("#confirmOverlay.open", { timeout: 5_000 });
        await page.click("#confirmAccept");
        await expect.poll(() => deleted, { timeout: 5_000 }).toContain("bbbb2222");
        expect(deleted).not.toContain("aaaa1111");
      } finally {
        if (browser) await browser.close().catch(() => {});
        if (started) stopServer(state);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
