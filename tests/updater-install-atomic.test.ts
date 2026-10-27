/**
 * W10.6: установка релиза проверяет целостность, ставится staged и не удаляет
 * живую версию до flip; updater идемпотентно останавливается; id сессий случайны.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertArtifactName,
  assertSafeTarMembers,
  downloadFile,
  installRelease,
  pruneStaleVersions,
  type InstallReleaseOptions,
  type InstallStep,
} from "../src/modules/updater/install-release";
import { tarPlan } from "../src/modules/updater/archive";
import { Updater } from "../src/modules/updater/checker";
import { UpdaterModule } from "../src/modules/updater/module";
import type { ReleaseManifest, ReleasePlatformKey } from "../src/modules/updater/release";

const KEY: ReleasePlatformKey = "win-x64";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mma-atomic-"));
  roots.push(root);
  return root;
}

function payloadFor(version: string): Buffer {
  return Buffer.from(`payload-${version}`);
}

function manifestFor(version: string, overrides: Record<string, unknown> = {}): ReleaseManifest {
  const payload = payloadFor(version);
  return {
    version,
    releasedAt: "2026-10-22T00:00:00Z",
    artifacts: {
      [KEY]: {
        url: `mma-${KEY}.tar.gz`,
        sha256: createHash("sha256").update(payload).digest("hex"),
        size: payload.length,
        ...overrides,
      },
    },
  } as ReleaseManifest;
}

function installer(version: string, overrides: Record<string, unknown> = {}) {
  const payload = payloadFor(version);
  const fetchImpl = (async () =>
    ({
      ok: true,
      headers: { get: () => String(payload.length) },
      body: null,
      arrayBuffer: async () =>
        payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length),
    }) as unknown as Response) as unknown as typeof fetch;
  return { fetchImpl, manifest: manifestFor(version, overrides) };
}

async function install(
  root: string,
  version: string,
  onStep?: (s: InstallStep) => void,
  overrides: Record<string, unknown> = {},
  extras: Partial<InstallReleaseOptions> = {},
): Promise<string> {
  const { fetchImpl, manifest } = installer(version, overrides);
  return await installRelease(
    {
      manifest,
      key: KEY,
      base: "https://releases.example",
      fetchImpl: fetchImpl as never,
      installRoot: root,
      extract: async (_tarball, dest) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(dest, "VERSION"), `${version}\n`);
      },
      ...(onStep ? { onStep } : {}),
      ...extras,
    },
    undefined,
  );
}

describe("install integrity", () => {
  it("refuses an artifact without a checksum", async () => {
    const root = await newRoot();
    const { fetchImpl, manifest } = installer("0.4.0", { sha256: undefined });
    await expect(
      installRelease({
        manifest,
        key: KEY,
        base: "https://releases.example",
        fetchImpl: fetchImpl as never,
        installRoot: root,
        extract: async () => {},
      }),
    ).rejects.toThrow(/checksum/i);
  });

  it("refuses a size mismatch", async () => {
    const root = await newRoot();
    await expect(install(root, "0.4.0", undefined, { size: payloadFor("0.4.0").length + 5 })).rejects.toThrow(
      /size mismatch/i,
    );
  });

  it("rejects unsafe artifact names", () => {
    for (const bad of ["../evil.tar.gz", "/abs.tar.gz", "C:\\evil.tar.gz", "https://evil/x.tar.gz"]) {
      expect(() => assertArtifactName(bad), bad).toThrow(/unsafe/);
    }
    expect(() => assertArtifactName("mma-win-x64.tar.gz")).not.toThrow();
  });

  it("rejects unsafe tar members and symlinks", () => {
    expect(() =>
      assertSafeTarMembers("-rw-r--r-- 0 0 0 1 Oct 22 12:00 ../evil"),
    ).toThrow(/unsafe/);
    expect(() =>
      assertSafeTarMembers("-rw-r--r-- 0 0 0 1 Oct 22 12:00 /etc/passwd"),
    ).toThrow(/unsafe/);
    expect(() =>
      assertSafeTarMembers("lrwxrwxrwx 0 0 0 0 Oct 22 12:00 link -> /etc/passwd"),
    ).toThrow(/type/);
    expect(() =>
      assertSafeTarMembers("-rw-r--r-- 0 0 0 1 Oct 22 12:00 mma/VERSION\ndrwxr-xr-x 0 0 0 0 Oct 22 12:00 mma/"),
    ).not.toThrow();
  });

  it("caps the download stream", async () => {
    const root = await newRoot();
    const fetchImpl = (async () =>
      ({
        ok: true,
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => new Uint8Array(64).buffer,
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(
      downloadFile("https://releases.example/x", join(root, "x"), fetchImpl as never, undefined, 10),
    ).rejects.toThrow(/size cap/i);
  });
});

describe("atomic install", () => {
  it("stages and flips before cleaning the old version", async () => {
    const root = await newRoot();
    const first: InstallStep[] = [];
    expect(await install(root, "0.4.0", (s) => first.push(s))).toBe("0.4.0");
    expect(first).toEqual(["stage", "flip"]);

    const second: InstallStep[] = [];
    let oldAliveAtFlip = false;
    await install(root, "0.4.1", (s) => {
      second.push(s);
      if (s === "flip") oldAliveAtFlip = existsSync(join(root, "versions", "0.4.0"));
    });
    expect(second.indexOf("stage")).toBeLessThan(second.indexOf("flip"));
    expect(second.indexOf("cleanup-old")).toBeGreaterThan(second.indexOf("flip"));
    expect(oldAliveAtFlip).toBe(true);

    expect((await readFile(join(root, "versions", "0.4.1", "VERSION"), "utf8")).trim()).toBe("0.4.1");
    await expect(stat(join(root, "versions", "0.4.0"))).rejects.toThrow();
    expect(await readlink(join(root, "current"))).toContain("0.4.1");
  });

  it("keeps the update when the old version is locked (Windows EACCES)", async () => {
    // Регресс 0.12.2: на Windows каталог работающей версии занят
    // `runtime/bun.exe`, `rm` падал с EACCES уже ПОСЛЕ flip, и применённое
    // обновление рапортовалось как «не удалось установить».
    const root = await newRoot();
    await install(root, "0.4.0");

    const steps: InstallStep[] = [];
    const leftover: string[][] = [];
    const version = await install(root, "0.4.1", (s) => steps.push(s), {}, {
      removeVersionDir: async () => false,
      onCleanupDeferred: (names) => leftover.push(names),
    });

    expect(version).toBe("0.4.1");
    expect(steps).toContain("flip");
    expect(steps).not.toContain("cleanup-old");
    expect(leftover.flat()).toContain("0.4.0");
    expect(await readlink(join(root, "current"))).toContain("0.4.1");
    expect((await readFile(join(root, "versions", "0.4.1", "VERSION"), "utf8")).trim()).toBe("0.4.1");
  });

  it("sweeps version directories left behind by earlier updates", async () => {
    const root = await newRoot();
    await install(root, "0.4.0");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "versions", "0.1.0"));
    await mkdir(join(root, "versions", "0.3.9"));

    await install(root, "0.4.1");
    for (const stale of ["0.1.0", "0.3.9", "0.4.0"]) {
      await expect(stat(join(root, "versions", stale)), stale).rejects.toThrow();
    }
    expect(await readlink(join(root, "current"))).toContain("0.4.1");
  });
});

describe("pruneStaleVersions", () => {
  it("removes garbage but keeps the active version and the running one", async () => {
    const root = await newRoot();
    await install(root, "0.4.0");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "versions", "0.2.0"));
    await mkdir(join(root, "versions", "0.3.0"));
    const running = join(root, "versions", "0.3.0");

    const result = await pruneStaleVersions({ root, keep: [running] });

    expect(result.removed).toEqual(expect.arrayContaining(["0.2.0"]));
    expect(result.deferred).toEqual([]);
    await expect(stat(join(root, "versions", "0.2.0"))).rejects.toThrow();
    expect((await stat(join(root, "versions", "0.3.0"))).isDirectory()).toBe(true);
    expect(await readlink(join(root, "current"))).toContain("0.4.0");
  });

  it("reports a locked directory as deferred instead of throwing", async () => {
    const root = await newRoot();
    await install(root, "0.4.0");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "versions", "0.3.0"));

    const result = await pruneStaleVersions({ root, removeVersionDir: async () => false });

    expect(result.removed).toEqual([]);
    expect(result.deferred).toEqual(["0.3.0"]);
  });
});

describe("updater lifecycle", () => {  it("stops cleanly and resolves the idle promise", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ version: "0.3.0", releasedAt: "", artifacts: {} }), {
        status: 200,
      })) as unknown as typeof fetch;
    const mod = new UpdaterModule(
      { enabled: true, autoInstall: false, intervalMs: 60_000 },
      new Updater("0.3.0", { fetchImpl }),
    );
    mod.start();
    mod.stop();
    await expect(mod.waitForIdle(1000)).resolves.toBe(true);
  });

  it("refuses a concurrent install", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fakeUpdater = {
      getCurrentVersion: () => "0.3.0",
      check: async () => ({ updateAvailable: true, current: "0.3.0", latest: "0.4.0" }),
      install: async () => {
        await gate;
        return { success: true, installed: "0.4.0" };
      },
    } as unknown as Updater;
    const mod = new UpdaterModule(
      { enabled: true, autoInstall: false, intervalMs: 0 },
      fakeUpdater,
      { info: () => {}, warn: () => {}, error: () => {} },
    );
    const first = mod.installNow();
    const second = await mod.installNow();
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/in progress/i);
    release();
    await expect(first).resolves.toMatchObject({ success: true });
  });
});

describe("tar: путь с буквой диска не уходит в аргумент", () => {
  it("архив передаётся basename при cwd (GNU tar читает C: как host:path)", () => {
    const plan = tarPlan(String.raw`C:\tmp\mma.tar.gz`, String.raw`C:\tmp\dest`);
    expect(plan.cwd.replace(/\\/g, "/")).toBe("C:/tmp");
    expect(plan.list[1]).toBe("mma.tar.gz");
    expect(plan.extract[1]).toBe("mma.tar.gz");
    // Именно имя архива GNU tar трактует как `host:path`; `-C` — обычный путь.
    for (const arg of [...plan.list, ...plan.extract].filter((a) => a.endsWith(".tar.gz"))) {
      expect(arg, `drive-letter path leaked to tar archive arg: ${arg}`).not.toMatch(/^[A-Za-z]:/);
    }
  });
});
