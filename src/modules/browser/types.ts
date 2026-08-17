export type BrowserAction =
  | "open"
  | "click"
  | "type"
  | "scroll"
  | "back"
  | "forward"
  | "screenshot"
  | "snapshot"
  | "close"
  | "wait";

export interface ElementEntry {
  index: number;
  tag: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  visible: boolean;
}

export type ConsoleType = "log" | "info" | "warning" | "error" | "debug" | "pageerror" | "network";

export interface ConsoleEntry {
  type: ConsoleType;
  text: string;
}

export interface NetworkErrorEntry {
  method: string;
  url: string;
  error: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementEntry[];
  content: string;
  console: ConsoleEntry[];
  networkErrors: NetworkErrorEntry[];
  truncated: boolean;
}

export interface BrowserState {
  isOpen: boolean;
  url: string | null;
  title: string | null;
  elementCount: number;
}

export interface BrowserConfig {
  headless: boolean;
  maxElements: number;
  maxContentChars: number;
  maxConsoleEntries: number;
  maxConsoleLineChars: number;
  screenshotMaxWidth: number;
  cookieDir: string;
  viewportWidth: number;
  viewportHeight: number;
  navigationTimeout: number;
}

export interface ActionResult {
  success: boolean;
  output: string;
  screenshot?: Buffer;
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  headless: true,
  maxElements: 30,
  maxContentChars: 2500,
  maxConsoleEntries: 40,
  maxConsoleLineChars: 400,
  screenshotMaxWidth: 1280,
  cookieDir: "",
  viewportWidth: 1280,
  viewportHeight: 720,
  navigationTimeout: 15000,
};
