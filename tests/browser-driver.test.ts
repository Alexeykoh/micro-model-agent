import { describe, it, expect } from "vitest";
import {
  resolveBrowserLaunchOverrides,
  launchChromiumWithFallback,
  type LaunchConfig,
  type ChromiumLaunchFn,
} from "../src/modules/browser/driver";

const CFG: LaunchConfig = {
  headless: true,
  viewport: { width: 1280, height: 720 },
  timeoutMs: 30000,
};

const MISSING = new Error(
  "browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell.exe",
);

function fakeBrowser(result: any = { ok: true }): any {
  return result;
}

describe("resolveBrowserLaunchOverrides", () => {
  it("reads MMA_BROWSER_EXECUTABLE / MMA_BROWSER_CHANNEL", () => {
    expect(
      resolveBrowserLaunchOverrides({
        MMA_BROWSER_EXECUTABLE: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        MMA_BROWSER_CHANNEL: " chrome ",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      channel: "chrome",
    });
  });

  it("returns an empty override when nothing is set", () => {
    expect(resolveBrowserLaunchOverrides({} as NodeJS.ProcessEnv)).toEqual({});
  });
});

describe("launchChromiumWithFallback", () => {
  it("falls back to system chrome when the bundled revision is missing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const launch: ChromiumLaunchFn = async (opts) => {
      calls.push(opts);
      if (opts.channel === "chrome") return fakeBrowser();
      throw MISSING;
    };
    await launchChromiumWithFallback(launch, CFG, {});
    expect(calls.map((c) => c.channel)).toEqual([undefined, "chrome"]);
  });

  it("tries msedge after chrome when both are missing", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const launch: ChromiumLaunchFn = async (opts) => {
      calls.push(opts);
      if (opts.channel === "msedge") return fakeBrowser();
      throw MISSING;
    };
    await launchChromiumWithFallback(launch, CFG, {});
    expect(calls.map((c) => c.channel)).toEqual([undefined, "chrome", "msedge"]);
  });

  it("an explicit executablePath is used as-is and suppresses the fallback", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const launch: ChromiumLaunchFn = async (opts) => {
      calls.push(opts);
      throw MISSING;
    };
    await expect(
      launchChromiumWithFallback(launch, CFG, { executablePath: "C:\\chrome.exe" }),
    ).rejects.toThrow(MISSING.message);
    expect(calls).toHaveLength(1);
    expect(calls[0].executablePath).toBe("C:\\chrome.exe");
    expect(calls[0].channel).toBeUndefined();
  });

  it("does NOT fall back on unrelated launch errors", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const launch: ChromiumLaunchFn = async (opts) => {
      calls.push(opts);
      throw new Error("Target page, context or browser has been closed");
    };
    await expect(launchChromiumWithFallback(launch, CFG, {})).rejects.toThrow(
      "Target page, context or browser has been closed",
    );
    expect(calls).toHaveLength(1);
  });
});
