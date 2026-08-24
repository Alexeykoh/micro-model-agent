import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync } from "fs";
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
} from "../src/modules/certification/manifest";
import type { CertificationEntry, CertManifest } from "../src/modules/certification/types";

const testDir = join(tmpdir(), `cert-m-${Math.random().toString(36).slice(2)}`);

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
  });
  afterEach(() => {
    rmSync(testDir, { force: true, recursive: true });
  });

  it("readManifest returns empty default", () => {
    const m = readManifest(testDir);
    expect(m.certifications).toEqual([]);
  });

  it("saveManifest round-trips", () => {
    const m: CertManifest = { version: 1, certifications: [entry("a")] };
    saveManifest(m, testDir);
    expect(readManifest(testDir).certifications).toHaveLength(1);
  });

  it("upsert adds new and replaces existing (dedup by model+providerUrl)", () => {
    const e1 = entry("a");
    const e2 = entry("a");
    e2.certifiedAt = "2026-08-06T00:00:00.000Z";
    upsertCertification(e1, testDir);
    upsertCertification(e2, testDir);
    const m = readManifest(testDir);
    expect(m.certifications).toHaveLength(1);
    expect(m.certifications[0].certifiedAt).toBe("2026-08-06T00:00:00.000Z");
  });

  it("removeCertification returns true when removed, false otherwise", () => {
    upsertCertification(entry("a"), testDir);
    expect(removeCertification("a", "http://localhost:8080", testDir)).toBe(true);
    expect(removeCertification("a", "http://localhost:8080", testDir)).toBe(false);
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

  it("getCertMark returns certified only for fully passed suites", () => {
    expect(getCertMark("a", "http://localhost:8080", "0.23.0", testDir)).toBe("none");
    upsertCertification(entry("a"), testDir);
    expect(getCertMark("a", "http://localhost:8080", "0.23.0", testDir)).toBe("certified");
    expect(getCertMark("a", "http://localhost:8080", "9.9.9", testDir)).toBe("stale");
    expect(getCertMark("zz", "http://localhost:8080", "0.23.0", testDir)).toBe("none");
  });

  it("getCertMark returns none for partially failed suites", () => {
    upsertCertification(entry("a", 1), testDir);
    expect(getCertMark("a", "http://localhost:8080", "0.23.0", testDir)).toBe("none");
  });
});
