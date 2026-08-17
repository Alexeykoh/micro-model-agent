export { BrowserModule } from "./module";
export { BrowserSession, BrowserActionTracker, ConsoleBuffer } from "./session";
export { CookieStore } from "./cookie-store";
export { createBrowserDriver, PlaywrightDriver, type BrowserDriver } from "./driver";
export { BridgeDriver } from "./bridge-client";
export { extractInteractiveElements, formatSnapshot, truncateText } from "./snapshot";
export type {
  BrowserConfig,
  BrowserState,
  ActionResult,
  ElementEntry,
  PageSnapshot,
  BrowserAction,
  ConsoleEntry,
  ConsoleType,
  NetworkErrorEntry,
} from "./types";
export { DEFAULT_BROWSER_CONFIG } from "./types";
