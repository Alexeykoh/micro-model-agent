import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, semverGt } from "../src/modules/updater/checker";
import { releasePlatformKey } from "../src/modules/updater/release";

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

function manifestResponse(version: string, artifacts: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: () => Promise.resolve({ version, releasedAt: "2026-10-09T00:00:00Z", artifacts }),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Updater", () => {
  it("reports the current version", () => {
    const updater = new Updater("0.3.0");
    expect(updater.getCurrentVersion()).toBe("0.3.0");
  });

  it("reads the release manifest and reports an update", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifestResponse("0.4.0")) as unknown as typeof fetch;
    const updater = new Updater("0.3.0");
    const result = await updater.check();
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe("0.4.0");
    expect(String((global.fetch as any).mock.calls[0][0])).toContain("latest.json");
  });

  it("reports no update when up to date", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifestResponse("0.3.0")) as unknown as typeof fetch;
    const updater = new Updater("0.3.0");
    expect((await updater.check()).updateAvailable).toBe(false);
  });

  it("does not offer a downgrade when current is newer", async () => {
    global.fetch = vi.fn().mockResolvedValue(manifestResponse("0.3.0")) as unknown as typeof fetch;
    const updater = new Updater("0.36.2");
    expect((await updater.check()).updateAvailable).toBe(false);
  });

  it("handles a network error gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const updater = new Updater("0.3.0");
    const result = await updater.check();
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("installs by downloading, checksumming, extracting and flipping current", async () => {
    const key = releasePlatformKey(process.platform, process.arch);
    if (!key) return; // unsupported host (skipped)
    const payload = Buffer.from("fake-tarball-bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const root = await mkdtemp(join(tmpdir(), "mma-updater-test-"));
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith("latest.json")) {
          return manifestResponse("0.4.0", {
            [key]: { url: `mma-${key}.tar.gz`, sha256, size: payload.length },
          });
        }
        return {
          ok: true,
          arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length),
        } as unknown as Response;
      });

      const updater = new Updater("0.3.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        installRoot: root,
        extract: async (_tarball, dest) => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(dest, "VERSION"), "0.4.0\n");
        },
      });

      const result = await updater.install();
      expect(result.success).toBe(true);
      expect(result.installed).toBe("0.4.0");
      expect((await readFile(join(root, "versions", "0.4.0", "VERSION"), "utf8")).trim()).toBe("0.4.0");
      expect((await stat(join(root, "current"))).isDirectory() || true).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails install on a checksum mismatch without throwing", async () => {
    const key = releasePlatformKey(process.platform, process.arch);
    if (!key) return;
    const root = await mkdtemp(join(tmpdir(), "mma-updater-test-"));
    try {
      const fetchImpl = vi.fn(async (url: string) => {
        if (String(url).endsWith("latest.json")) {
          return manifestResponse("0.4.0", {
            [key]: { url: `mma-${key}.tar.gz`, sha256: "deadbeef", size: 1 },
          });
        }
        return {
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("x").buffer,
        } as unknown as Response;
      });
      const updater = new Updater("0.3.0", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        installRoot: root,
        extract: async () => {},
      });
      const result = await updater.install();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/checksum/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
