import type { ConsoleEntry, NetworkErrorEntry } from "./types";
import type { StoredCookie } from "./cookie-store";

/** Explicit browser location/channel resolved from the environment. */
export interface BrowserLaunchOverrides {
  executablePath?: string;
  channel?: string;
}

export interface LaunchConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  timeoutMs: number;
  overrides?: BrowserLaunchOverrides;
}

/**
 * Driver contract shared by the Playwright driver, the Node bridge driver and
 * the session. Kept in its own module so `bridge-client.ts` does not import
 * `driver.ts` (which dynamically imports it) — that edge was one of the cycles.
 */
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
