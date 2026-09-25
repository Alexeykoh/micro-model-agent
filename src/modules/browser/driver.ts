import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ConsoleEntry, ConsoleType, NetworkErrorEntry, BrowserConfig } from "./types";
import { ConsoleBuffer } from "./console-buffer";
import type { StoredCookie } from "./cookie-store";
import type { BrowserDriver, LaunchConfig, BrowserLaunchOverrides } from "./driver-types";

export type { BrowserDriver, LaunchConfig, BrowserLaunchOverrides } from "./driver-types";

export const DIRECT_LAUNCH_TIMEOUT_MS = 8000;

export function resolveBrowserLaunchOverrides(
  env: NodeJS.ProcessEnv = process.env,
): BrowserLaunchOverrides {
  const executablePath = env.MMA_BROWSER_EXECUTABLE?.trim();
  const channel = env.MMA_BROWSER_CHANNEL?.trim();
  const out: BrowserLaunchOverrides = {};
  if (executablePath) out.executablePath = executablePath;
  if (channel) out.channel = channel;
  return out;
}

/** System browsers to try when the bundled Chromium revision is missing. */
const SYSTEM_CHANNEL_FALLBACKS = ["chrome", "msedge"];

function isMissingBrowserError(err: unknown): boolean {
  return /Executable doesn't exist|is not found|looks like Playwright was just installed/i.test(
    String((err as { message?: string })?.message ?? err),
  );
}

/** Injectable launcher so the fallback chain is unit-testable without a browser. */
export type ChromiumLaunchFn = (opts: Record<string, unknown>) => Promise<Browser>;

/**
 * Launch Chromium, falling back to an installed system Chrome/Edge when the
 * bundled revision is absent (CDN unreachable). An explicit override always
 * wins and suppresses the fallback — the user's choice must fail loudly.
 */
export async function launchChromiumWithFallback(
  launch: ChromiumLaunchFn,
  cfg: LaunchConfig,
  overrides: BrowserLaunchOverrides = {},
): Promise<Browser> {
  const base = { headless: cfg.headless, timeout: cfg.timeoutMs, ...overrides };
  try {
    return await launch(base);
  } catch (err) {
    const explicit = overrides.executablePath || overrides.channel;
    if (explicit || !isMissingBrowserError(err)) throw err;
    let lastErr: unknown = err;
    for (const channel of SYSTEM_CHANNEL_FALLBACKS) {
      try {
        return await launch({ ...base, channel });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }
}

function launchChromium(cfg: LaunchConfig, overrides: BrowserLaunchOverrides): Promise<Browser> {
  return launchChromiumWithFallback(
    (opts) => chromium.launch(opts as Parameters<typeof chromium.launch>[0]),
    cfg,
    overrides,
  );
}

export class PlaywrightDriver implements BrowserDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private console = new ConsoleBuffer();
  private network: NetworkErrorEntry[] = [];

  async launch(cfg: LaunchConfig): Promise<void> {
    if (this.browser) return;

    this.browser = await launchChromium(cfg, cfg.overrides ?? {});
    this.context = await this.browser.newContext({ viewport: cfg.viewport });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(cfg.timeoutMs);

    this.page.on("console", (msg) => this.console.add(msg.type() as ConsoleType, msg.text()));
    this.page.on("pageerror", (err) => this.console.add("pageerror", `Page error: ${err.message}`));
    this.page.on("requestfailed", (req) => {
      const failure = req.failure();
      this.network.push({
        method: req.method(),
        url: req.url(),
        error: failure?.errorText || "unknown",
      });
    });
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    this.requirePage();
    this.console.clear();
    this.network = [];
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }

  async evaluate(js: string): Promise<unknown> {
    return this.requirePage().evaluate(js);
  }

  async content(): Promise<string> {
    return this.requirePage().content();
  }

  async title(): Promise<string> {
    return this.requirePage().title();
  }

  url(): string {
    return this.page?.url() || "";
  }

  async waitForLoad(timeoutMs: number): Promise<void> {
    await this.requirePage()
      .waitForLoadState("domcontentloaded", { timeout: timeoutMs })
      .catch(() => {});
  }

  async screenshot(): Promise<Buffer> {
    return this.requirePage().screenshot({ type: "png", fullPage: false });
  }

  async cookies(): Promise<StoredCookie[]> {
    if (!this.context) return [];
    return this.context.cookies() as Promise<StoredCookie[]>;
  }

  async addCookies(cookies: StoredCookie[]): Promise<void> {
    if (!this.context || cookies.length === 0) return;
    await this.context.addCookies(cookies as any);
  }

  async goBack(timeoutMs: number): Promise<void> {
    await this.requirePage()
      .goBack({ waitUntil: "domcontentloaded", timeout: timeoutMs })
      .catch(() => {});
  }

  async goForward(timeoutMs: number): Promise<void> {
    await this.requirePage()
      .goForward({ waitUntil: "domcontentloaded", timeout: timeoutMs })
      .catch(() => {});
  }

  resetEventLog(): void {
    this.console.clear();
    this.network = [];
  }

  getConsole(): ConsoleEntry[] {
    return this.console.getAll();
  }

  getNetworkErrors(): NetworkErrorEntry[] {
    return this.network.slice(-15);
  }

  async close(): Promise<void> {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  dispose(): void {
    this.close().catch(() => {});
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("No page open");
    return this.page;
  }
}

export function createBrowserDriver(config: BrowserConfig): Promise<BrowserDriver> {
  const common: LaunchConfig = {
    headless: config.headless,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    timeoutMs: config.navigationTimeout,
    overrides: resolveBrowserLaunchOverrides(),
  };

  return (async () => {
    // Playwright's pipe/websocket transport is broken under Bun on some
    // platforms (see oven-sh/bun#31105, #9911). Under Bun we always use the
    // Node bridge. Under Node we try the direct path first.
    if (process.versions.bun) {
      return launchBridge(config, common);
    }

    const direct = new PlaywrightDriver();
    try {
      await direct.launch({ ...common, timeoutMs: DIRECT_LAUNCH_TIMEOUT_MS });
      return direct;
    } catch {
      direct.dispose();
    }

    return launchBridge(config, common);
  })();
}

async function launchBridge(config: BrowserConfig, common: LaunchConfig): Promise<BrowserDriver> {
  const { BridgeDriver } = await import("./bridge-client");
  const bridge = new BridgeDriver({ maxConsoleLineChars: config.maxConsoleLineChars });
  await bridge.launch(common);
  return bridge;
}
