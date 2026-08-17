import { describe, it, expect, vi } from "vitest";
import { platform } from "os";
import { Updater, semverGt } from "../src/modules/updater/checker";

describe("semverGt", () => {
  it("compares major/minor/patch numerically", () => {
    expect(semverGt("0.36.2", "0.36.1")).toBe(true);
    expect(semverGt("0.36.1", "0.36.1")).toBe(false);
    expect(semverGt("0.36.1", "0.36.2")).toBe(false);
    expect(semverGt("1.0.0", "0.99.99")).toBe(true);
    expect(semverGt("0.4.0", "0.3.0")).toBe(true);
    expect(semverGt("0.3.0", "0.4.0")).toBe(false);
  });

  it("tolerates v-prefix and partial parts", () => {
    expect(semverGt("v0.36.2", "0.36.1")).toBe(true);
    expect(semverGt("0.10", "0.9.1")).toBe(true);
    expect(semverGt("0.36.2", "0.36")).toBe(true);
  });
});

describe("Updater", () => {
  it("should report current version", () => {
    const updater = new Updater("0.3.0", "micro-models-agent");
    expect(updater.getCurrentVersion()).toBe("0.3.0");
  });

  it("should check npm registry", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ "dist-tags": { latest: "0.4.0" } }),
    });
    global.fetch = mockFetch as any;

    const updater = new Updater("0.3.0", "micro-models-agent");
    const result = await updater.check();
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe("0.4.0");
  });

  it("should report no update when up to date", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ "dist-tags": { latest: "0.3.0" } }),
    });
    global.fetch = mockFetch as any;

    const updater = new Updater("0.3.0", "micro-models-agent");
    const result = await updater.check();
    expect(result.updateAvailable).toBe(false);
  });

  it("should NOT report a downgrade when current is newer than latest", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ "dist-tags": { latest: "0.3.0" } }),
    });
    global.fetch = mockFetch as any;

    const updater = new Updater("0.36.2", "micro-models-agent");
    const result = await updater.check();
    expect(result.updateAvailable).toBe(false);
  });

  it("should handle network errors gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    global.fetch = mockFetch as any;

    const updater = new Updater("0.3.0", "micro-models-agent");
    const result = await updater.check();
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should install the latest version globally via injected runner", async () => {
    const runner = vi.fn().mockResolvedValue({});
    const updater = new Updater("0.3.0", "micro-models-agent", runner as any);
    const result = await updater.install("0.4.0");
    expect(result.success).toBe(true);
    expect(result.installed).toBe("0.4.0");
    const [command, args] = runner.mock.calls[0] as [string, string[]];
    if (platform() === "win32") {
      expect(command).toBe("cmd.exe");
      expect(args[0]).toBe("/c");
      expect(args[1]).toMatch(/^npm\.cmd$/);
      expect(args.slice(2)).toEqual(["install", "-g", "micro-models-agent@0.4.0"]);
    } else {
      expect(command).toBe("npm");
      expect(args).toEqual(["install", "-g", "micro-models-agent@0.4.0"]);
    }
  });

  it("should report install failure without throwing", async () => {
    const runner = vi.fn().mockResolvedValue({ error: "EACCES permission denied" });
    const updater = new Updater("0.3.0", "micro-models-agent", runner as any);
    const result = await updater.install("0.4.0");
    expect(result.success).toBe(false);
    expect(result.error).toContain("EACCES");
  });
});
