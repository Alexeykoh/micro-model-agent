import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdaterModule } from "../src/modules/updater/module";
import { Updater } from "../src/modules/updater/checker";
import { releasePlatformKey } from "../src/modules/updater/release";
import type { UpdaterConfig } from "../src/config/types";
import type { UpdateNotice } from "../src/modules/updater/module";

function makeConfig(overrides: Partial<UpdaterConfig> = {}): UpdaterConfig {
  return { enabled: true, autoInstall: false, intervalMs: 0, ...overrides };
}

function manifest(version: string, artifacts: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: () => Promise.resolve({ version, releasedAt: "2026-10-09T00:00:00Z", artifacts }),
  } as unknown as Response;
}

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };

/** Модуль с тихим логгером и сбором уведомлений. */
function observedMod(
  notices: UpdateNotice[],
  over: Partial<UpdaterConfig> = {},
  updater: Updater = new Updater("0.3.0"),
): UpdaterModule {
  return new UpdaterModule(makeConfig(over), updater, QUIET, (n) => notices.push(n));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UpdaterModule", () => {
  it("does not start when disabled", () => {
    const mod = new UpdaterModule(makeConfig({ enabled: false }), new Updater("0.3.0"));
    mod.start();
    expect(mod.isStarted()).toBe(false);
  });

  it("starts a single check (intervalMs 0) and finishes", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifest("0.3.0")) as unknown as typeof fetch;
    const mod = new UpdaterModule(makeConfig(), new Updater("0.3.0"));
    mod.setInstallEnabled(false);
    mod.start();
    expect(mod.isStarted()).toBe(true);
    await mod.runOnce();
    await new Promise((r) => setTimeout(r, 30));
    expect(mod.isStarted()).toBe(false);
  });

  it("notifies when an update is available (no auto-install)", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifest("0.4.0")) as unknown as typeof fetch;
    const messages: string[] = [];
    const mod = new UpdaterModule(makeConfig({ autoInstall: false }), new Updater("0.3.0"), {
      info: (m) => messages.push(m),
      warn: (m) => messages.push(m),
      error: (m) => messages.push(m),
    });
    mod.setInstallEnabled(false);
    await mod.runOnce();
    expect(messages.some((m) => m.includes("0.4.0"))).toBe(true);
  });

  it("auto-installs when enabled", async () => {
    const key = releasePlatformKey(process.platform, process.arch);
    if (!key) return;
    const payload = Buffer.from("bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const root = await mkdtemp(join(tmpdir(), "mma-mod-test-"));
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith("latest.json")) {
          return manifest("0.4.0", { [key]: { url: `mma-${key}.tar.gz`, sha256, size: payload.length } });
        }
        return {
          ok: true,
          arrayBuffer: async () =>
            payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length),
        } as unknown as Response;
      });
      const messages: string[] = [];
      const mod = new UpdaterModule(
        makeConfig({ autoInstall: true }),
        new Updater("0.3.0", {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          installRoot: root,
          extract: async (_t, dest) => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(join(dest, "VERSION"), "0.4.0\n");
          },
        }),
        { info: (m) => messages.push(m), warn: (m) => messages.push(m), error: (m) => messages.push(m) },
      );
      await mod.runOnce();
      expect(messages.some((m) => m.includes("0.4.0") && /installed|установлено/i.test(m))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops the loop", () => {
    const mod = new UpdaterModule(makeConfig({ intervalMs: 60000 }), new Updater("0.3.0"));
    mod.start();
    expect(mod.isStarted()).toBe(true);
    mod.stop();
    expect(mod.isStarted()).toBe(false);
  });

  it("waitForIdle resolves after the single-shot check settles", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifest("0.3.0")) as unknown as typeof fetch;
    const mod = new UpdaterModule(makeConfig(), new Updater("0.3.0"));
    mod.setInstallEnabled(false);
    mod.start();
    await mod.waitForIdle(2000);
    expect(mod.isStarted()).toBe(false);
  });

  it("waitForIdle returns immediately when never started", async () => {
    const mod = new UpdaterModule(makeConfig(), new Updater("0.3.0"));
    await mod.waitForIdle(500);
    expect(mod.isStarted()).toBe(false);
  });

  it("mentions the auto-install switch in the notify-only message", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifest("0.4.0")) as unknown as typeof fetch;
    const messages: string[] = [];
    const mod = new UpdaterModule(makeConfig({ autoInstall: false }), new Updater("0.3.0"), {
      info: () => {},
      warn: (m) => messages.push(m),
      error: () => {},
    });
    mod.setInstallEnabled(false);
    await mod.runOnce();
    expect(messages.join("\n")).toMatch(/updater\.autoInstall/);
  });

  it("notifies the observer on every phase", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifest("0.4.0")) as unknown as typeof fetch;
    const notices: UpdateNotice[] = [];
    const mod = observedMod(notices);
    mod.setInstallEnabled(false);
    await mod.runOnce();
    expect(notices).toEqual([{ phase: "available", current: "0.3.0", latest: "0.4.0" }]);
  });

  it("stays silent when there is nothing newer", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifest("0.3.0")) as unknown as typeof fetch;
    const notices: UpdateNotice[] = [];
    const mod = observedMod(notices);
    mod.setInstallEnabled(false);
    await mod.runOnce();
    expect(notices).toHaveLength(0);
  });

  it("reports a failed install so the UI can react", async () => {
    const key = releasePlatformKey(process.platform, process.arch);
    if (!key) return;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("latest.json")) {
        return manifest("0.4.0", { [key]: { url: `mma-${key}.tar.gz`, sha256: "deadbeef", size: 1 } });
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer } as unknown as Response;
    });
    const notices: UpdateNotice[] = [];
    const root = await mkdtemp(join(tmpdir(), "mma-mod-test-"));
    try {
      const mod = observedMod(
        notices,
        { autoInstall: true },
        new Updater("0.3.0", {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          installRoot: root,
          extract: async () => {},
        }),
      );
      await mod.runOnce();
      expect(notices[0]?.phase).toBe("failed");
      expect(notices[0]?.error).toMatch(/checksum/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains a failed install in plain language, with the exact reinstall command", async () => {
    const key = releasePlatformKey(process.platform, process.arch);
    if (!key) return;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("latest.json")) {
        return manifest("0.4.0", { [key]: { url: `mma-${key}.tar.gz`, sha256: "deadbeef", size: 1 } });
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer } as unknown as Response;
    });
    const root = await mkdtemp(join(tmpdir(), "mma-mod-test-"));
    const warnings: string[] = [];
    const infos: string[] = [];
    try {
      const mod = new UpdaterModule(
        makeConfig({ autoInstall: true }),
        new Updater("0.3.0", {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          installRoot: root,
          extract: async () => {},
        }),
        {
          info: (m) => infos.push(m),
          warn: (m) => warnings.push(m),
          error: () => {},
        },
      );
      await mod.runOnce();
      const [what, hint] = warnings.join("\n").split("\n");
      // STYLE.md: одна строка «что + причина» и одна подсказка «↳ что делать».
      expect(what).not.toContain("[updater]");
      expect(what).not.toContain("deadbeef");
      expect(what).toMatch(/corrupted|повреждено/i);
      expect(hint).toContain("↳");
      expect(hint).toMatch(/install\.(ps1|sh)/);
      // Сырой технический текст остаётся диагностикой, а не текстом ошибки.
      expect(infos.join("\n")).toContain("checksum");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stays silent on a failed check (no notice, log only)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const notices: UpdateNotice[] = [];
    const mod = observedMod(notices);
    mod.setInstallEnabled(false);
    await mod.runOnce();
    expect(notices).toHaveLength(0);
  });

  it("installNow logs, streams progress phases and reports installed", async () => {
    const key = releasePlatformKey(process.platform, process.arch);
    if (!key) return;
    const payload = Buffer.from("bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const root = await mkdtemp(join(tmpdir(), "mma-mod-test-"));
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith("latest.json")) {
          return manifest("0.4.0", { [key]: { url: `mma-${key}.tar.gz`, sha256, size: payload.length } });
        }
        return {
          ok: true,
          arrayBuffer: async () =>
            payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length),
        } as unknown as Response;
      });
      const messages: string[] = [];
      const notices: UpdateNotice[] = [];
      const mod = new UpdaterModule(
        makeConfig(),
        new Updater("0.3.0", {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          installRoot: root,
          extract: async (_t, dest) => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(join(dest, "VERSION"), "0.4.0\n");
          },
        }),
        { info: (m) => messages.push(m), warn: (m) => messages.push(m), error: (m) => messages.push(m) },
        (n) => notices.push(n),
      );
      const r = await mod.installNow();
      expect(r.success).toBe(true);
      expect(messages.some((m) => /Downloading|Скачивание/.test(m))).toBe(true);
      expect(notices.some((n) => n.phase === "installing")).toBe(true);
      expect(notices.some((n) => n.phase === "installed")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installNow refuses to install in dev (install disabled)", async () => {
    const mod = observedMod([]);
    mod.setInstallEnabled(false);
    const r = await mod.installNow();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not available/i);
  });
});
