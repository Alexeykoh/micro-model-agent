import { describe, it, expect, afterEach } from "vitest";
import {
  BrowserSession,
  BrowserActionTracker,
  ConsoleBuffer,
} from "../src/modules/browser/session";
import { DEFAULT_BROWSER_CONFIG } from "../src/modules/browser/types";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("ConsoleBuffer", () => {
  it("stores entries with type and text", () => {
    const buf = new ConsoleBuffer(10);
    buf.add("error", "Uncaught TypeError: x");
    const all = buf.getAll();
    expect(all.length).toBe(1);
    expect(all[0].type).toBe("error");
    expect(all[0].text).toContain("Uncaught TypeError");
  });

  it("caps the number of entries", () => {
    const buf = new ConsoleBuffer(3);
    for (let i = 0; i < 10; i++) buf.add("log", `msg ${i}`);
    const all = buf.getAll();
    expect(all.length).toBe(3);
    expect(all[2].text).toBe("msg 9");
  });

  it("truncates long lines", () => {
    const buf = new ConsoleBuffer(5);
    buf.add("log", "x".repeat(500));
    const all = buf.getAll();
    expect(all[0].text.length).toBeLessThan(500);
    expect(all[0].text.endsWith("…")).toBe(true);
  });

  it("ignores empty text", () => {
    const buf = new ConsoleBuffer(5);
    buf.add("log", "   ");
    expect(buf.size).toBe(0);
  });

  it("clears on request", () => {
    const buf = new ConsoleBuffer(5);
    buf.add("log", "a");
    buf.clear();
    expect(buf.size).toBe(0);
  });
});

describe("BrowserActionTracker", () => {
  it("detects repeated same action on same URL", () => {
    const tracker = new BrowserActionTracker(3);
    tracker.record("click", { target: 1 }, "https://example.com");
    tracker.record("click", { target: 1 }, "https://example.com");
    const warning = tracker.record("click", { target: 1 }, "https://example.com");
    expect(warning).toBeTruthy();
    expect(warning).toContain("repeated");
  });

  it("does not warn for different actions", () => {
    const tracker = new BrowserActionTracker(3);
    tracker.record("click", { target: 1 }, "https://example.com");
    tracker.record("type", { target: 2, text: "hi" }, "https://example.com");
    const warning = tracker.record("scroll", { direction: "down" }, "https://example.com");
    expect(warning).toBeNull();
  });

  it("does not warn for different URLs", () => {
    const tracker = new BrowserActionTracker(3);
    tracker.record("click", { target: 1 }, "https://example.com");
    tracker.record("click", { target: 1 }, "https://other.com");
    const warning = tracker.record("click", { target: 1 }, "https://third.com");
    expect(warning).toBeNull();
  });

  it("resets after navigation", () => {
    const tracker = new BrowserActionTracker(3);
    tracker.record("click", { target: 1 }, "https://example.com");
    tracker.record("click", { target: 1 }, "https://example.com");
    tracker.reset();
    const warning = tracker.record("click", { target: 1 }, "https://example.com");
    expect(warning).toBeNull();
  });
});

describe("BrowserSession", () => {
  let session: BrowserSession | null = null;
  const cookieDir = mkdtempSync(join(tmpdir(), "mma-browser-sess-"));

  afterEach(async () => {
    if (session) {
      await session.close();
      session = null;
    }
  });

  it("starts in closed state", () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir });
    const state = session.getState();
    expect(state.isOpen).toBe(false);
    expect(state.url).toBeNull();
  });

  it.skip("opens a page and returns snapshot (requires browser)", async () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir });
    const result = await session.execute("open", { url: "https://example.com" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Example Domain");
    const state = session.getState();
    expect(state.isOpen).toBe(true);
    expect(state.url).toContain("example.com");
  }, 30000);

  it("returns error for unknown action", async () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir });
    const result = await session.execute("invalid_action" as any, {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown action");
  });

  it("returns error when clicking without open page", async () => {
    session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir });
    const result = await session.execute("click", { target: 1 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("No page open");
  });
});
