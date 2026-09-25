import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readManifest,
  saveManifest,
  upsertCertification,
  removeCertification,
  isStale,
  getCertMark,
  isFullyPassed,
  readGlobalManifest,
  saveGlobalManifest,
  readMergedManifest,
  syncGlobalManifest,
  globalManifestPath,
} from "../src/modules/certification/manifest";
import type { CertificationEntry, CertManifest } from "../src/modules/certification/types";

const testDir = join(tmpdir(), `cert-m-${Math.random().toString(36).slice(2)}`);
const globalDir = join(tmpdir(), `cert-m-g-${Math.random().toString(36).slice(2)}`);

function entry(model: string, failed = 0): CertificationEntry {
  return {
    model,
    providerUrl: "http://localhost:8080",
    mmaVersion: "0.23.0",
    certifiedAt: "2026-08-05T00:00:00.000Z",
    suite: { passed: failed === 0 ? 2 : 1, failed, skipped: 1, total: 3 },
    results: [],
  };
}

describe("cert manifest", () => {
  beforeEach(() => {
    rmSync(testDir, { force: true, recursive: true });
    rmSync(globalDir, { force: true, recursive: true });
  });
  afterEach(() => {
    rmSync(testDir, { force: true, recursive: true });
    rmSync(globalDir, { force: true, recursive: true });
  });

  it("readManifest returns empty default", () => {
    const m = readManifest(testDir);
    expect(m.certifications).toEqual([]);
  });

  it("readGlobalManifest returns empty default", () => {
    expect(readGlobalManifest(globalDir).certifications).toEqual([]);
  });

  it("saveManifest round-trips", () => {
    const m: CertManifest = { version: 1, certifications: [entry("a")] };
    saveManifest(m, testDir);
    expect(readManifest(testDir).certifications).toHaveLength(1);
  });

  it("upsert writes to the GLOBAL manifest (dedup by model+providerUrl)", () => {
    const e1 = entry("a");
    const e2 = entry("a");
    e2.certifiedAt = "2026-08-06T00:00:00.000Z";
    upsertCertification(e1, globalDir);
    upsertCertification(e2, globalDir);
    const g = readGlobalManifest(globalDir);
    expect(g.certifications).toHaveLength(1);
    expect(g.certifications[0].certifiedAt).toBe("2026-08-06T00:00:00.000Z");
  });

  it("removeCertification removes from global and legacy project manifests", () => {
    upsertCertification(entry("a"), globalDir);
    saveManifest({ version: 1, certifications: [entry("a")] }, testDir);
    const r = removeCertification("a", "http://localhost:8080", {
      globalDir,
      projectDir: testDir,
    });
    expect(r.global).toBe(true);
    expect(r.project).toBe(true);
    expect(readGlobalManifest(globalDir).certifications).toHaveLength(0);
    expect(readManifest(testDir).certifications).toHaveLength(0);
    expect(
      removeCertification("a", "http://localhost:8080", { globalDir, projectDir: testDir }),
    ).toEqual({ global: false, project: false });
  });

  it("isStale compares mmaVersion", () => {
    expect(isStale(entry("a"), "0.23.0")).toBe(false);
    expect(isStale(entry("a"), "0.24.0")).toBe(true);
  });

  it("isFullyPassed returns true only when no failures and at least one pass", () => {
    expect(isFullyPassed(entry("a"))).toBe(true);
    expect(isFullyPassed(entry("a", 1))).toBe(false);
    const zeroPass: CertificationEntry = { ...entry("a"), suite: { passed: 0, failed: 0, skipped: 3, total: 3 } };
    expect(isFullyPassed(zeroPass)).toBe(false);
  });

  it("getCertMark reads the MERGED (global + project) manifest", () => {
    // entry only in the global manifest — visible without any project file
    saveGlobalManifest({ version: 1, certifications: [entry("g")] }, globalDir);
    expect(getCertMark("g", "http://localhost:8080", "0.23.0", testDir, globalDir)).toBe("certified");
    expect(getCertMark("g", "http://localhost:8080", "9.9.9", testDir, globalDir)).toBe("stale");

    // project entry wins over a conflicting global one on the same key
    const newer = entry("g");
    newer.mmaVersion = "9.9.9";
    saveManifest({ version: 1, certifications: [newer] }, testDir);
    expect(getCertMark("g", "http://localhost:8080", "0.23.0", testDir, globalDir)).toBe("stale");

    expect(getCertMark("zz", "http://localhost:8080", "0.23.0", testDir, globalDir)).toBe("none");
  });

  it("merged manifest prefers the newer entry over a stale project manifest", () => {
    // Регрессия: старый git-tracked project-manifest перекрывал свежую global.
    saveGlobalManifest(
      { version: 1, certifications: [{ ...entry("g"), mmaVersion: "1.4.0" }] },
      globalDir,
    );
    saveManifest({ version: 1, certifications: [{ ...entry("g"), mmaVersion: "0.51.2" }] }, testDir);

    const merged = readMergedManifest(testDir, globalDir);
    expect(merged.certifications.find((c) => c.model === "g")?.mmaVersion).toBe("1.4.0");
  });

  it("getCertMark returns none for partially failed suites", () => {
    saveGlobalManifest({ version: 1, certifications: [entry("a", 1)] }, globalDir);
    expect(getCertMark("a", "http://localhost:8080", "0.23.0", testDir, globalDir)).toBe("none");
  });
});

describe("syncGlobalManifest (bundled → global)", () => {
  let bundledDir: string;
  let bundledPath: string;

  beforeEach(() => {
    bundledDir = join(tmpdir(), `cert-m-b-${Math.random().toString(36).slice(2)}`);
    bundledPath = join(bundledDir, "certification", "certifications.json");
    mkdirSync(join(bundledDir, "certification"), { recursive: true });
    rmSync(testDir, { force: true, recursive: true });
    rmSync(globalDir, { force: true, recursive: true });
  });
  afterEach(() => {
    rmSync(bundledDir, { force: true, recursive: true });
    rmSync(testDir, { force: true, recursive: true });
    rmSync(globalDir, { force: true, recursive: true });
  });

  function writeBundled(models: string[]): void {
    writeFileSync(
      bundledPath,
      JSON.stringify({
        version: 1,
        certifications: models.map((m) => ({ ...entry(m), providerUrl: "http://bundled:1234/v1" })),
      }),
      "utf-8",
    );
  }

  it("reports no-bundled when nothing shipped", () => {
    const r = syncGlobalManifest(globalDir, join(bundledDir, "missing.json"));
    expect(r).toEqual({ synced: false, reason: "no-bundled" });
  });

  it("copies bundled entries into the global manifest once, then no-ops", () => {
    writeBundled(["bundled-model"]);
    const first = syncGlobalManifest(globalDir, bundledPath);
    expect(first).toEqual({ synced: true, reason: "synced" });
    expect(readGlobalManifest(globalDir).certifications.map((c) => c.model)).toContain(
      "bundled-model",
    );
    expect(existsSync(globalManifestPath(globalDir))).toBe(true);
    expect(existsSync(join(globalDir, "certifications.synced.json"))).toBe(true);

    // Same bundled content again → unchanged, no rewrite
    const second = syncGlobalManifest(globalDir, bundledPath);
    expect(second).toEqual({ synced: false, reason: "unchanged" });
  });

  it("update overwrites bundled keys but preserves user-only entries", () => {
    const user = { ...entry("user-local"), providerUrl: "http://localhost:1234/v1" };
    saveGlobalManifest({ version: 1, certifications: [user] }, globalDir);

    writeFileSync(
      bundledPath,
      JSON.stringify({
        version: 1,
        certifications: [{ ...entry("shared"), mmaVersion: "0.50.0", providerUrl: "http://b/v1" }],
      }),
      "utf-8",
    );
    syncGlobalManifest(globalDir, bundledPath);
    let g = readGlobalManifest(globalDir);
    expect(g.certifications).toHaveLength(2);

    // Package update ships a new version of the same key
    writeFileSync(
      bundledPath,
      JSON.stringify({
        version: 1,
        certifications: [{ ...entry("shared"), mmaVersion: "0.52.1", providerUrl: "http://b/v1" }],
      }),
      "utf-8",
    );
    syncGlobalManifest(globalDir, bundledPath);
    g = readGlobalManifest(globalDir);
    const shared = g.certifications.find((c) => c.model === "shared");
    const local = g.certifications.find((c) => c.model === "user-local");
    expect(shared?.mmaVersion).toBe("0.52.1");
    expect(local).toBeDefined();
  });

  it("does not downgrade a fresher user-local certification", () => {
    // Регрессия: свежий certify (1.4.0) затирался старой bundled-копией (0.51.2).
    const fresh = {
      ...entry("qwen/qwen3.5-9b"),
      providerUrl: "http://localhost:1234/v1",
      mmaVersion: "1.4.0",
      certifiedAt: "2026-09-21T00:00:00.000Z",
    };
    saveGlobalManifest({ version: 1, certifications: [fresh] }, globalDir);

    writeFileSync(
      bundledPath,
      JSON.stringify({
        version: 1,
        certifications: [
          {
            ...entry("qwen/qwen3.5-9b"),
            providerUrl: "http://localhost:1234/v1",
            mmaVersion: "0.51.2",
            certifiedAt: "2026-08-25T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
    syncGlobalManifest(globalDir, bundledPath);

    const g = readGlobalManifest(globalDir);
    const kept = g.certifications.find((c) => c.model === "qwen/qwen3.5-9b");
    expect(kept?.mmaVersion).toBe("1.4.0");
  });
});
