/**
 * Playwright e2e over a REAL `mma web` child process with an isolated
 * `MMA_CONFIG_DIR` (see `./web-harness.ts`).
 *
 * Scenarios:
 *  1. `web boot` — page loads, topbar + composer render, no console errors,
 *     the first-run setup gate stays closed (non-virgin seed).
 *  2. `provider nested dialog` — settings → Model & Provider → "+ add" opens
 *     `#providerOverlay` above the settings modal; Esc closes it; backdrop
 *     click closes it; filling the form and saving adds the provider to the
 *     list without touching the real `~/.mma`.
 *
 * Artifacts per scenario land in `_testing/web-e2e/<name>/` (gitignored):
 * screenshots, `page.html`, `console.log`, `result.json`.
 *
 * Run ONLY on explicit request: `bun run test:e2e`.
 * Skips gracefully without a Chromium binary, and never runs under Bun
 * (Playwright's pipe transport hangs there — same guard as webui-smoke).
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  startE2EServer,
  stopE2EServer,
  expectNonVirgin,
  artifactsDirFor,
  type E2EConfig,
} from "./web-harness";

function isMissingBrowserError(err: unknown): boolean {
  return /Executable doesn't exist|is not found|looks like Playwright was just installed/i.test(
    String((err as { message?: string } | null)?.message ?? err),
  );
}

/** Bundled Chromium revision, only if the binary actually exists. */
function bundledChromiumPath(): string | null {
  try {
    const bundled = chromium.executablePath();
    return bundled && existsSync(bundled) ? bundled : null;
  } catch {
    return null;
  }
}

function discoverChromium(): string | null {
  const env = process.env.MMA_BROWSER_EXECUTABLE?.trim();
  if (env && existsSync(env)) return env;
  return bundledChromiumPath();
}

const CHROMIUM = discoverChromium();
const CAN_RUN = CHROMIUM !== null && !process.versions.bun;
// Static skip: Bun never enters the body (dynamic ctx.skip() hangs under Bun).
const e2e = CAN_RUN ? it : it.skip;

interface Launched {
  browser: Browser;
  page: Page;
  errors: string[];
}

function writeArtifacts(
  dir: string,
  name: string,
  data: { html?: string; consoleErrors: string[]; extra?: Record<string, unknown> },
): void {
  mkdirSync(dir, { recursive: true });
  if (data.html !== undefined) writeFileSync(join(dir, `${name}.html`), data.html);
  writeFileSync(join(dir, `${name}.console.log`), data.consoleErrors.join("\n"));
  writeFileSync(
    join(dir, `${name}.result.json`),
    JSON.stringify({ scenario: name, errors: data.consoleErrors, ...data.extra }, null, 2),
  );
}

async function launch(url: string): Promise<Launched> {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROMIUM ?? undefined,
    timeout: 15_000,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${url}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForSelector(".bar-top", { timeout: 10_000 });
  return { browser, page, errors };
}

async function openModelPanel(page: Page): Promise<void> {
  await page.click("#openSettings");
  await page.waitForSelector("#overlay.open", { timeout: 10_000 });
  await page.click('[data-p="model"]');
  await page.waitForSelector('[data-panel="model"]', { timeout: 10_000 });
}

/** Boot assertions + artifacts (topbar, composer, no console errors). */
async function checkBootPage(page: Page, errors: string[], dir: string): Promise<void> {
  await page.waitForSelector("#openSettings", { timeout: 10_000 });
  expect(await page.locator(".composer #inp").count()).toBe(1);
  expect(await page.locator(".composer #sendBtn").count()).toBe(1);
  await page.screenshot({ path: join(dir, "boot.png") });
  writeArtifacts(dir, "boot", { html: await page.content(), consoleErrors: errors });
  expect(errors).toEqual([]);
}

/** Nested-overlay chrome: open via "+ add", close via Esc, close via backdrop. */
async function checkOverlayChrome(page: Page, dir: string): Promise<void> {
  await openModelPanel(page);
  await page.waitForSelector(".sec-add", { timeout: 10_000 });

  await page.click(".sec-add");
  await page.waitForSelector("#providerOverlay.open", { timeout: 10_000 });
  expect(await page.locator("#overlay.open").count()).toBe(1);
  await page.screenshot({ path: join(dir, "dialog-open.png") });

  await page.keyboard.press("Escape");
  await page.waitForSelector("#providerOverlay.open", { state: "hidden", timeout: 10_000 });
  expect(await page.locator("#overlay.open").count()).toBe(1);

  await page.click(".sec-add");
  await page.waitForSelector("#providerOverlay.open", { timeout: 10_000 });
  await page.mouse.click(5, 5);
  await page.waitForSelector("#providerOverlay.open", { state: "hidden", timeout: 10_000 });
}

/** Fill the provider form, save, and assert the list grew by one. */
async function saveNewProvider(page: Page, baseUrl: string, dir: string): Promise<string> {
  const before = await page.locator(".provider-item").count();
  await page.click(".sec-add");
  await page.waitForSelector("#providerOverlay.open", { timeout: 10_000 });
  const inputs = page.locator("#providerFormHost input");
  const label = `e2e-prov-${Date.now().toString(36)}`;
  await inputs.nth(0).fill("openai-compat");
  await inputs.nth(1).fill(label);
  await inputs.nth(2).fill("http://127.0.0.1:9/v1");
  await page.screenshot({ path: join(dir, "dialog-filled.png") });
  // Save/cancel are <button class="linkbtn"> (see `link()` in assets/app.js).
  await page.locator(".pform-actions button").first().click();
  await page.waitForSelector("#providerOverlay.open", { state: "hidden", timeout: 10_000 });
  await expect.poll(() => page.locator(".provider-item").count(), { timeout: 10_000 }).toBe(before + 1);
  const names = await page.locator(".provider-item").allInnerTexts();
  expect(names.some((t) => t.includes(label))).toBe(true);
  await page.screenshot({ path: join(dir, "dialog-saved.png") });

  // The isolated config actually persisted the new entry.
  const saved = (await (await fetch(`${baseUrl}/api/providers`)).json()) as {
    entries?: Array<{ label?: string }>;
  };
  expect((saved.entries ?? []).some((e) => e.label === label)).toBe(true);
  return label;
}

/** Run `fn` with a booted server + browser, always stopping both. */
async function withE2E(dir: string, fn: (srv: E2EConfig, l: Launched) => Promise<void>): Promise<void> {
  const srv = await startE2EServer({ artifactsDir: dir });
  let browser: Browser | null = null;
  try {
    let launched: Launched;
    try {
      launched = await launch(srv.baseUrl);
    } catch (err) {
      if (isMissingBrowserError(err)) return;
      throw err;
    }
    browser = launched.browser;
    await fn(srv, launched);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopE2EServer(srv);
  }
}

describe("web e2e (isolated MMA_CONFIG_DIR)", () => {
  e2e(
    "boot: page renders, composer present, no console errors, setup gate closed",
    async () => {
      const dir = artifactsDirFor("boot");
      await withE2E(dir, async (srv, { page, errors }) => {
        await expectNonVirgin(srv.baseUrl);
        await checkBootPage(page, errors, dir);
      });
    },
    120_000,
  );

  e2e(
    "provider nested dialog: open, Esc, backdrop, save adds provider",
    async () => {
      const dir = artifactsDirFor("provider-dialog");
      await withE2E(dir, async (srv, { page, errors }) => {
        await checkOverlayChrome(page, dir);
        const label = await saveNewProvider(page, srv.baseUrl, dir);
        writeArtifacts(dir, "provider-dialog", {
          html: await page.content(),
          consoleErrors: errors,
          extra: { label },
        });
        expect(errors).toEqual([]);
      });
    },
    180_000,
  );
});
