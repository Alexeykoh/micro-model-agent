import type { BrowserConfig, BrowserState, ActionResult } from "./types";
import type { BrowserDriver } from "./driver";
import { createBrowserDriver } from "./driver";
import { extractInteractiveElements, formatSnapshot } from "./snapshot";
import {
  buildClickScript,
  buildTypeScript,
  buildScrollScript,
  buildIndexInjectionScript,
  buildTextExtractionScript,
} from "./actions";
import { CookieStore, type StoredCookie } from "./cookie-store";
import { t } from "../../i18n/index";
import type { ConsoleEntry, ConsoleType } from "./types";

const CONSOLE_MAX_LINE = 400;

export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries;
  }

  add(type: ConsoleType, text: string): void {
    const clean = String(text).replace(/\s+/g, " ").trim();
    if (!clean) return;
    const line = clean.length > CONSOLE_MAX_LINE ? `${clean.slice(0, CONSOLE_MAX_LINE)}…` : clean;
    this.entries.push({ type, text: line });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  clear(): void {
    this.entries = [];
  }

  getAll(): ConsoleEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }
}

export class BrowserActionTracker {
  private history: Array<{
    action: string;
    args: Record<string, unknown>;
    url: string;
  }> = [];
  private threshold: number;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  record(action: string, args: Record<string, unknown>, url: string): string | null {
    this.history.push({ action, args, url });

    if (this.history.length < this.threshold) return null;

    const recent = this.history.slice(-this.threshold);
    const allSame = recent.every(
      (h) =>
        h.action === recent[0].action &&
        h.url === recent[0].url &&
        JSON.stringify(h.args) === JSON.stringify(recent[0].args),
    );

    if (allSame) {
      return t("browser.repeated_action", {
        action,
        threshold: this.threshold,
      });
    }

    return null;
  }

  reset(): void {
    this.history = [];
  }
}

export class BrowserSession {
  private driver: BrowserDriver | null = null;
  private config: BrowserConfig;
  private cookieStore: CookieStore;
  private state: BrowserState = {
    isOpen: false,
    url: null,
    title: null,
    elementCount: 0,
  };
  private actionTracker = new BrowserActionTracker(3);

  constructor(config: BrowserConfig) {
    this.config = config;
    this.cookieStore = new CookieStore(config.cookieDir);
  }

  getState(): BrowserState {
    return { ...this.state };
  }

  async execute(action: string, args: Record<string, unknown>): Promise<ActionResult> {
    try {
      let result: ActionResult;
      switch (action) {
        case "open":
          result = await this.open(String(args.url || ""));
          break;
        case "click":
          result = await this.click(Number(args.target));
          break;
        case "type":
          result = await this.type(Number(args.target), String(args.text || ""));
          break;
        case "scroll":
          result = await this.scroll(String(args.direction || "down"));
          break;
        case "back":
          result = await this.back();
          break;
        case "forward":
          result = await this.forward();
          break;
        case "screenshot":
          result = await this.screenshot();
          break;
        case "snapshot":
          result = await this.snapshot();
          break;
        case "close":
          result = await this.close();
          break;
        case "wait":
          result = await this.wait(Number(args.ms || 1000));
          break;
        default:
          return {
            success: false,
            output: t("browser.unknown_action", { action }),
          };
      }

      if (action !== "open") {
        const warning = this.actionTracker.record(action, args, this.driver?.url() || "");
        if (warning && result.success) {
          result.output = `${result.output}\n\n⚠️ ${warning}`;
        }
      }

      return result;
    } catch (err: any) {
      return {
        success: false,
        output: t("browser.error", { message: err.message }),
      };
    }
  }

  private async ensureDriver(): Promise<ActionResult | null> {
    if (!this.driver) {
      return { success: false, output: t("browser.no_page") };
    }
    return null;
  }

  private async launch(): Promise<void> {
    if (this.driver) return;

    this.driver = await createBrowserDriver(this.config);

    const savedCookies = await this.cookieStore.load();
    if (savedCookies.length > 0) {
      await this.driver.addCookies(savedCookies);
    }
  }

  private async saveCookies(): Promise<void> {
    if (!this.driver) return;
    const cookies = await this.driver.cookies();
    await this.cookieStore.save(cookies as StoredCookie[]);
  }

  private async takeSnapshot(): Promise<string> {
    if (!this.driver) return "No page open.";

    await this.driver.evaluate(buildIndexInjectionScript());
    const html = await this.driver.content();
    const url = this.driver.url();
    const title = await this.driver.title();

    let content = "";
    try {
      content = String(await this.driver.evaluate(buildTextExtractionScript()));
    } catch {
      content = "";
    }

    const allElements = extractInteractiveElements(html, this.config.maxElements + 5);
    const truncated = allElements.length > this.config.maxElements;
    const elements = allElements.slice(0, this.config.maxElements);

    this.state = {
      isOpen: true,
      url,
      title,
      elementCount: elements.length,
    };

    return formatSnapshot({
      url,
      title,
      elements,
      content,
      console: this.driver.getConsole(),
      networkErrors: this.driver.getNetworkErrors(),
      truncated,
    });
  }

  private async open(url: string): Promise<ActionResult> {
    if (!url) return { success: false, output: t("browser.url_required") };

    // Security: block dangerous schemes (file:, chrome:, about:, data:).
    if (/^(file|chrome|about|data|javascript|view-source):/i.test(url)) {
      return { success: false, output: `[SECURITY BLOCKED] scheme not allowed: ${url}` };
    }

    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("file://")) {
      const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(url);
      url = isLocalhost ? `http://${url}` : `https://${url}`;
    }

    await this.launch();
    if (!this.driver) return { success: false, output: t("browser.create_page_failed") };

    this.actionTracker.reset();
    this.driver.resetEventLog();

    try {
      await this.driver.goto(url, this.config.navigationTimeout);
    } catch (err: any) {
      return {
        success: false,
        output: t("browser.nav_failed", { message: err.message }),
      };
    }

    const snapshot = await this.takeSnapshot();
    await this.saveCookies();
    return { success: true, output: snapshot };
  }

  private async click(target: number): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    if (!this.driver) return { success: false, output: "No page" };

    if (!target || target < 1) {
      return { success: false, output: t("browser.invalid_target") };
    }

    try {
      await this.driver.evaluate(buildClickScript(target));
      await this.driver.waitForLoad(5000);
      await new Promise((r) => setTimeout(r, 500));
      const snapshot = await this.takeSnapshot();
      await this.saveCookies();
      return { success: true, output: snapshot };
    } catch (err: any) {
      return {
        success: false,
        output: t("browser.click_failed", { message: err.message }),
      };
    }
  }

  private async type(target: number, text: string): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    if (!this.driver) return { success: false, output: "No page" };

    if (!target || target < 1) {
      return { success: false, output: t("browser.invalid_target_short") };
    }
    if (!text) {
      return { success: false, output: t("browser.text_required") };
    }

    try {
      await this.driver.evaluate(buildTypeScript(target, text));
      const snapshot = await this.takeSnapshot();
      return { success: true, output: snapshot };
    } catch (err: any) {
      return {
        success: false,
        output: t("browser.type_failed", { message: err.message }),
      };
    }
  }

  private async scroll(direction: string): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    if (!this.driver) return { success: false, output: "No page" };

    const dir = direction as "up" | "down" | "top" | "bottom";
    if (!["up", "down", "top", "bottom"].includes(dir)) {
      return { success: false, output: t("browser.direction_invalid") };
    }

    try {
      await this.driver.evaluate(buildScrollScript(dir));
      await new Promise((r) => setTimeout(r, 300));
      const snapshot = await this.takeSnapshot();
      return { success: true, output: snapshot };
    } catch (err: any) {
      return {
        success: false,
        output: t("browser.scroll_failed", { message: err.message }),
      };
    }
  }

  private async back(): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    if (!this.driver) return { success: false, output: "No page" };

    await this.driver.goBack(this.config.navigationTimeout);
    await new Promise((r) => setTimeout(r, 300));
    const snapshot = await this.takeSnapshot();
    return { success: true, output: snapshot };
  }

  private async forward(): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    if (!this.driver) return { success: false, output: "No page" };

    await this.driver.goForward(this.config.navigationTimeout);
    await new Promise((r) => setTimeout(r, 300));
    const snapshot = await this.takeSnapshot();
    return { success: true, output: snapshot };
  }

  private async screenshot(): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    if (!this.driver) return { success: false, output: "No page" };

    const buffer = await this.driver.screenshot();
    const snapshot = await this.takeSnapshot();
    return { success: true, output: snapshot, screenshot: buffer };
  }

  private async snapshot(): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    const snap = await this.takeSnapshot();
    return { success: true, output: snap };
  }

  private async wait(ms: number): Promise<ActionResult> {
    const err = await this.ensureDriver();
    if (err) return err;
    await new Promise((r) => setTimeout(r, Math.min(ms, 10000)));
    const snapshot = await this.takeSnapshot();
    return { success: true, output: snapshot };
  }

  async close(): Promise<ActionResult> {
    await this.saveCookies();
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
    this.state = { isOpen: false, url: null, title: null, elementCount: 0 };
    return { success: true, output: t("browser.closed") };
  }
}
