// Web auto-update: the shared factory (dev guard, notice wiring) and the web
// wiring that turns a notice into an SSE event + snapshot fact. `mma web` used
// to skip the updater entirely (`exitOnComplete` disabled it), which left the
// four `updater.*` toggles in the settings panel dead.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createUpdater } from "../src/modules/updater/factory";
import type { UpdateNotice } from "../src/modules/updater/module";
import type { UpdaterConfig } from "../src/config/types";

const cfg = (over: Partial<UpdaterConfig> = {}): UpdaterConfig => ({
  enabled: true,
  autoInstall: false,
  intervalMs: 0,
  ...over,
});

const PUBLISHED = "/x/dist/main.js";
const DEV_ENTRY = "/x/src/cli/main.ts";

function mockRegistry(latest: string): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ version: latest, releasedAt: "", artifacts: {} }),
  }) as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createUpdater", () => {
  it("refuses to self-update from a TypeScript entry (checkout safety)", () => {
    mockRegistry("99.0.0");
    const mod = createUpdater({ config: cfg(), entryPath: DEV_ENTRY });
    expect(mod).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("starts a published install against the release manifest", async () => {
    mockRegistry("0.0.1"); // older than this checkout — no notice expected
    const mod = createUpdater({ config: cfg(), entryPath: PUBLISHED });
    expect(mod).not.toBeUndefined();
    expect(mod!.isStarted()).toBe(true);
    await mod!.waitForIdle(2000);
    expect(global.fetch).toHaveBeenCalled();
    expect(String((global.fetch as any).mock.calls[0][0])).toContain("latest.json");
    mod!.stop();
  });

  it("does not start when updater.enabled is false", () => {
    mockRegistry("99.0.0");
    const mod = createUpdater({ config: cfg({ enabled: false }), entryPath: PUBLISHED });
    expect(mod).not.toBeUndefined();
    // The module builds, but refuses to run — the switch is the module's gate.
    expect(mod!.isStarted()).toBe(false);
    mod!.stop();
  });

  it("reports an available update to the observer", async () => {
    mockRegistry("999.0.0");
    const notices: UpdateNotice[] = [];
    const mod = createUpdater({
      config: cfg(),
      entryPath: PUBLISHED,
      onNotice: (n) => notices.push(n),
    });
    await mod!.waitForIdle(5000);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0].phase).toBe("available");
    expect(notices[0].latest).toBe("999.0.0");
    mod!.stop();
  });

  it("stays quiet when the registry is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as any;
    const notices: UpdateNotice[] = [];
    const mod = createUpdater({
      config: cfg(),
      entryPath: PUBLISHED,
      onNotice: (n) => notices.push(n),
    });
    await mod!.waitForIdle(5000);
    expect(notices).toHaveLength(0);
    mod!.stop();
  });
});

describe("web updater wiring (source contract)", () => {
  it("web never consults exitOnComplete for the updater", async () => {
    const { readFileSync } = await import("node:fs");
    const web = readFileSync("src/cli/web-command.ts", "utf8");
    // `exitOnComplete` exists to decide who owns stdin; the updater never
    // touches stdin (fetch + execFile), so gating it on that flag silently
    // killed web updates while the settings panel still showed the toggles.
    expect(web).toContain("exitOnComplete=true: в веб-режиме интерактивный промпт stdin не владеет.");
    expect(web).not.toMatch(/exitOnComplete\s*\?\s*undefined\s*:\s*startAutoUpdate/);
    expect(web).not.toMatch(/updater.*exitOnComplete\s*\?/);
  });

  it("starts the updater in web-command and stops it on shutdown", async () => {
    const { readFileSync } = await import("node:fs");
    const web = readFileSync("src/cli/web-command.ts", "utf8");
    expect(web).toContain("startWebUpdater(config, web.state)");
    expect(web).toContain("updater?.stop()");
  });

  it("broadcasts an `update` SSE event and records the snapshot fact", async () => {
    const { readFileSync } = await import("node:fs");
    const web = readFileSync("src/cli/web-command.ts", "utf8");
    expect(web).toContain('type: "update"');
    expect(web).toContain("state.updateAvailable");
    expect(web).toContain("pushState(state)");
  });

  it("carries updateAvailable in the host snapshot", async () => {
    const { readFileSync } = await import("node:fs");
    // Проекция снапшота живёт в core (фронтендонезависима); web-обвязка её реэкспортирует.
    expect(readFileSync("src/core/host-state.ts", "utf8")).toContain("updateAvailable");
    expect(readFileSync("src/core/host.ts", "utf8")).toContain("updateAvailable");
  });
});