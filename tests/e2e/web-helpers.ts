/**
 * Shared Playwright scaffolding for `mma web` feature scenarios.
 *
 * Same rules as `web-harness.ts`: real `mma web` child + isolated
 * `MMA_CONFIG_DIR`, artifacts under `_testing/web-e2e/<scenario>/`,
 * run ONLY via `bun run test:e2e`, skip without a Chromium binary or on Bun.
 */
import { it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  startE2EServer,
  stopE2EServer,
  artifactsDirFor,
  type E2EConfig,
} from "./web-harness";

export function isMissingBrowserError(err: unknown): boolean {
  return /Executable doesn't exist|is not found|looks like Playwright was just installed/i.test(
    String((err as { message?: string } | null)?.message ?? err),
  );
}

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
export const e2e = CAN_RUN ? it : it.skip;

export interface Launched {
  browser: Browser;
  page: Page;
  errors: string[];
}

export function writeArtifacts(
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

export async function launch(url: string): Promise<Launched> {
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
  // Let the boot sequence (i18n, config, sessions) settle before scenarios.
  // On failure name the collected console/page errors: a dead feed is usually
  // a broken frontend module (e.g. Uncaught SyntaxError kills the import graph).
  try {
    await page.waitForFunction(() => document.querySelector("#msgs .empty, #msgs .feed"), {
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`feed never booted; console/page errors: ${errors.join(" | ") || "(none)"} — ${String(err)}`);
  }
  return { browser, page, errors };
}

/** Run `fn` with a booted server + browser, always stopping both. */
export async function withE2E(
  dir: string,
  fn: (srv: E2EConfig, l: Launched) => Promise<void>,
  serverOpts?: { port?: number; providerBaseUrl?: string },
): Promise<void> {
  const srv = await startE2EServer({ artifactsDir: dir, ...serverOpts });
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

/**
 * Wait until the server auto-opened the active session tab. Sending before
 * that loses streamed output: SSE never replays, and a tab-less feed drops
 * `command`/`turn_end` events silently.
 */
export async function waitForLiveTab(page: Page, timeout = 30_000): Promise<void> {
  await expect.poll(() => page.locator(".stab").count(), { timeout }).toBeGreaterThan(0);
}

/** Type a line into the composer and submit it with Enter. */
export async function sendLine(page: Page, line: string): Promise<void> {
  await page.fill("#inp", line);
  await page.press("#inp", "Enter");
}

/**
 * Wait until a `.cmdout` feed line contains `text` (slash-command output
 * streams over SSE as `command` events). Returns the matched line count.
 */
export async function waitCmdOut(
  page: Page,
  text: string | RegExp,
  timeout = 15_000,
): Promise<number> {
  const loc = page.locator(".cmdout", { hasText: text });
  await expect.poll(() => loc.count(), { timeout }).toBeGreaterThan(0);
  return loc.count();
}

/** POST JSON to the e2e server (auth-free loopback bind). */
export async function apiPost(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

export async function apiGet(baseUrl: string, path: string): Promise<{ status: number; json: never }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: (await res.json()) as never };
}

/** Session ids on the isolated server. */
export async function sessionIds(baseUrl: string): Promise<string[]> {
  const body = (await apiGet(baseUrl, "/api/sessions")).json as {
    sessions: Array<{ id: string }>;
  };
  return body.sessions.map((s) => s.id);
}

/** Session count on the isolated server. */
export async function sessionCount(baseUrl: string): Promise<number> {
  return (await sessionIds(baseUrl)).length;
}

/** Create a session through the topbar button; return the created id. */
export async function createSessionTopbar(page: Page, baseUrl: string): Promise<string> {
  const before = await sessionIds(baseUrl);
  await page.click("#newChat");
  let created = "";
  await expect
    .poll(async () => {
      const ids = await sessionIds(baseUrl);
      created = ids.filter((id) => !before.includes(id)).join();
      return created;
    })
    .not.toBe("");
  return created;
}

/**
 * Wait until the open dropdown shows `id` as active. The active badge follows
 * the 2s `/api/state` poll, so deleting earlier can offer a stale victim —
 * which the server then correctly refuses with 409.
 */
export async function waitActiveBadge(page: Page, id: string): Promise<void> {
  await page.click("#sessBtn");
  await page.waitForFunction(
    (wanted) => document.querySelector("#sessActiveList .si .id")?.textContent?.trim() === wanted,
    id,
    { timeout: 20_000 },
  );
}

/** First dropdown row carrying a delete control (the active row has none). */
export async function deletableRow(page: Page): Promise<number> {
  const rows = page.locator(".dd-menu .si-row");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    if ((await rows.nth(i).locator(".del-btn").count()) > 0) return i;
  }
  return -1;
}

/**
 * First session of the isolated server. Deliberately branch-free (the
 * complexity gate counts every `?.`/`??`): a broken server fails loudly with
 * a TypeError instead of a soft empty value.
 */
export async function firstSession(baseUrl: string): Promise<{ id: string; name: string }> {
  const body = (await apiGet(baseUrl, "/api/sessions")).json as {
    sessions: Array<{ id: string; name: string }>;
  };
  const first = body.sessions[0];
  return { id: first.id, name: first.name || first.id };
}

/** Active provider name of the isolated server (always set by the server). */
export async function activeProvider(baseUrl: string): Promise<string> {
  const body = (await apiGet(baseUrl, "/api/providers")).json as { active: string };
  return body.active;
}

export { artifactsDirFor };
