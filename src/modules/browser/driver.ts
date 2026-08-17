import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ConsoleEntry, ConsoleType, NetworkErrorEntry, BrowserConfig } from "./types";
import { ConsoleBuffer } from "./session";
import type { StoredCookie } from "./cookie-store";

export const DIRECT_LAUNCH_TIMEOUT_MS = 8000;

export interface LaunchConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  timeoutMs: number;
}

export interface BrowserDriver {
  launch(cfg: LaunchConfig): Promise<void>;
  goto(url: string, timeoutMs: number): Promise<void>;
  evaluate(js: string): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  waitForLoad(timeoutMs: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  cookies(): Promise<StoredCookie[]>;
  addCookies(cookies: StoredCookie[]): Promise<void>;
  goBack(timeoutMs: number): Promise<void>;
  goForward(timeoutMs: number): Promise<void>;
  resetEventLog(): void;
  getConsole(): ConsoleEntry[];
  getNetworkErrors(): NetworkErrorEntry[];
  close(): Promise<void>;
  dispose(): void;
}

export class PlaywrightDriver implements BrowserDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private console = new ConsoleBuffer();
  private network: NetworkErrorEntry[] = [];

  async launch(cfg: LaunchConfig): Promise<void> {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: cfg.headless,
      timeout: cfg.timeoutMs,
    });
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
