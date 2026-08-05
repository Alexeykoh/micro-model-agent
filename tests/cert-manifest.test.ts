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
} from "../src/modules/certification/manifest";
import type { CertificationEntry, CertManifest } from "../src/modules/certification/types";

const testPath = join(tmpdir(), `cert-m-${Math.random().toString(36).slice(2)}.json`);

function entry(model: string): CertificationEntry {
  return {
    model,
    providerUrl: "http://localhost:8080",
    mmaVersion: "0.23.0",
    certifiedAt: "2026-08-05T00:00:00.000Z",
    suite: { passed: 2, failed: 0, skipped: 1, total: 3 },
    results: [],
  };
}

describe("cert manifest", () => {
  beforeEach(() => { rmSync(testPath, { force: true }); });
  afterEach(() => { rmSync(testPath, { force: true }); });

  it("readManifest returns empty default", () => {
    const m = readManifest(testPath);
    expect(m.certifications).toEqual([]);
  });

  it("saveManifest round-trips", () => {
    const m: CertManifest = { version: 1, certifications: [entry("a")] };
    saveManifest(m, testPath);
    expect(readManifest(testPath).certifications).toHaveLength(1);
  });

  it("upsert adds new and replaces existing (dedup by model+providerUrl)", () => {
    const e1 = entry("a");
    const e2 = entry("a");
    e2.certifiedAt = "2026-08-06T00:00:00.000Z";
    upsertCertification(e1, testPath);
    upsertCertification(e2, testPath);
    const m = readManifest(testPath);
    expect(m.certifications).toHaveLength(1);
    expect(m.certifications[0].certifiedAt).toBe("2026-08-06T00:00:00.000Z");
  });

  it("removeCertification returns true when removed, false otherwise", () => {
    upsertCertification(entry("a"), testPath);
    expect(removeCertification("a", "http://localhost:8080", testPath)).toBe(true);
    expect(removeCertification("a", "http://localhost:8080", testPath)).toBe(false);
  });

  it("isStale compares mmaVersion", () => {
    expect(isStale(entry("a"), "0.23.0")).toBe(false);
    expect(isStale(entry("a"), "0.24.0")).toBe(true);
  });

  it("getCertMark returns certified/stale/none", () => {
    expect(getCertMark("a", "http://localhost:8080", "0.23.0", testPath)).toBe("none");
    upsertCertification(entry("a"), testPath);
    expect(getCertMark("a", "http://localhost:8080", "0.23.0", testPath)).toBe("certified");
    expect(getCertMark("a", "http://localhost:8080", "9.9.9", testPath)).toBe("stale");
    expect(getCertMark("zz", "http://localhost:8080", "0.23.0", testPath)).toBe("none");
  });
});
