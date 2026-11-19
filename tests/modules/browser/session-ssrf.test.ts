import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BrowserSession } from "../../../src/modules/browser/session";
import { DEFAULT_BROWSER_CONFIG } from "../../../src/modules/browser/types";
import { DEFAULT_SECURITY_CONFIG } from "../../../src/config/security";

/**
 * Браузер не открывает приватные адреса и metadata-эндпоинты облака
 * (аудит §2.3, план `2026-10-12-harness-module-audit-fixes`, W4/Task 4.3).
 * Проверка не требует самого браузера: блок происходит до запуска драйвера.
 */

describe("BrowserSession: SSRF", () => {
  const cookieDir = mkdtempSync(join(tmpdir(), "mma-browser-ssrf-"));

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/admin",
    "http://localhost:1234/v1/models",
    "http://127.0.0.1:8080/",
    "http://[::1]/",
  ])("refuses %s", async (url) => {
    const session = new BrowserSession({
      ...DEFAULT_BROWSER_CONFIG,
      cookieDir,
      networkSecurity: DEFAULT_SECURITY_CONFIG.network,
    });
    const result = await session.execute("open", { url });
    expect(result.success).toBe(false);
    expect(result.output).toContain("SECURITY BLOCKED");
    await session.close();
  });
});
