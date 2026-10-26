// Сессия браузера: диспетчер действий модели, трекер повторов, снапшоты страниц.
import type { BrowserConfig, BrowserState, ActionResult } from "./types";
import type { BrowserDriver } from "./driver-types";
import { createBrowserDriver } from "./driver";
import { captureSnapshot } from "./snapshot-capture";
import {
  buildClickScript,
  buildTypeScript,
  buildScrollScript,
} from "./actions";
import { CookieStore, type StoredCookie } from "./cookie-store";
import { checkBrowserUrl } from "./url-policy";
import { isChromiumInstalled, BrowserUnavailableError } from "./preflight";
import { BrowserActionTracker } from "./action-tracker";
import { t } from "../../i18n/index";

export { BrowserActionTracker } from "./action-tracker";

/** Сессия: ленивый драйвер, куки, выполнение действий модели, снапшоты. */
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

  /** Копия текущего состояния (открыта/URL/заголовок/счётчик элементов). */
  getState(): BrowserState {
    return { ...this.state };
  }

  /** Выполнить действие модели (open/click/type/…); ошибки — текстом в ActionResult. */
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
      if (err instanceof BrowserUnavailableError) {
        return { success: false, output: err.message };
      }
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

    // Предполёт: без Chromium сообщение должно называть команду установки,
    // а не «No page open» (аудит §3.3).
    if (!(await isChromiumInstalled())) {
      throw new BrowserUnavailableError();
    }

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
    const capture = await captureSnapshot(this.driver, this.config);
    this.state = capture.state;
    return capture.text;
  }

  private async open(url: string): Promise<ActionResult> {
    // Схемы, нормализация и SSRF-проверка — в `url-policy.ts`.
    const policy = await checkBrowserUrl(url, this.config.networkSecurity);
    if (!policy.ok) {
      return { success: false, output: `[SECURITY BLOCKED] ${policy.reason}` };
    }
    url = policy.url;

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

  /** Закрыть сессию: сохранить куки, убить драйвер, сбросить состояние. */
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
