import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BrowserSession } from "../../../src/modules/browser/session";
import { DEFAULT_BROWSER_CONFIG } from "../../../src/modules/browser/types";
import {
  setChromiumInstalledOverride,
  resetChromiumPreflight,
  CHROMIUM_INSTALL_CMD,
} from "../../../src/modules/browser/preflight";

/**
 * Без Chromium браузер должен говорить, что доставить, а не «No page open»
 * (аудит §3.3, план `2026-10-12-harness-module-audit-fixes`, W4/Task 4.5).
 */

afterEach(() => {
  setChromiumInstalledOverride(undefined);
  resetChromiumPreflight();
});

describe("BrowserSession: предполёт Chromium", () => {
  it("reports the install command instead of 'no page open'", async () => {
    setChromiumInstalledOverride(false);
    const cookieDir = mkdtempSync(join(tmpdir(), "mma-browser-preflight-"));
    const session = new BrowserSession({ ...DEFAULT_BROWSER_CONFIG, cookieDir });
    const result = await session.execute("open", { url: "https://example.com" });
    expect(result.success).toBe(false);
    expect(result.output).toContain(CHROMIUM_INSTALL_CMD);
    expect(result.output).not.toContain("No page open");
    await session.close();
  });
});
