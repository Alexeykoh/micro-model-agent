import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { CertManifest, CertificationEntry, CertMark } from "./types";

export function manifestPath(projectDir: string): string {
  return join(projectDir, "certification", "certifications.json");
}

export function readManifest(projectDir: string): CertManifest {
  const path = manifestPath(projectDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as CertManifest;
      return { version: 1, certifications: raw.certifications ?? [] };
    }
  } catch {
    /* corrupted manifest → start fresh */
  }
  return { version: 1, certifications: [] };
}

export function saveManifest(m: CertManifest, projectDir: string): void {
  const path = manifestPath(projectDir);
  mkdirSync(join(projectDir, "certification"), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2), "utf-8");
}

export function upsertCertification(
  entry: CertificationEntry,
  projectDir: string,
): CertManifest {
  const m = readManifest(projectDir);
  const idx = m.certifications.findIndex(
    (e) => e.model === entry.model && e.providerUrl === entry.providerUrl,
  );
  if (idx >= 0) m.certifications[idx] = entry;
  else m.certifications.push(entry);
  saveManifest(m, projectDir);
  return m;
}

export function removeCertification(
  model: string,
  providerUrl: string,
  projectDir: string,
): boolean {
  const m = readManifest(projectDir);
  const before = m.certifications.length;
  m.certifications = m.certifications.filter(
    (e) => !(e.model === model && e.providerUrl === providerUrl),
  );
  if (m.certifications.length !== before) {
    saveManifest(m, projectDir);
    return true;
  }
  return false;
}

export function isStale(entry: CertificationEntry, currentVersion: string): boolean {
  return entry.mmaVersion !== currentVersion;
}

export function isFullyPassed(entry: CertificationEntry): boolean {
  return entry.suite.failed === 0 && entry.suite.passed > 0;
}

export function getCertMark(
  model: string,
  providerUrl: string,
  currentVersion: string,
  projectDir: string,
): CertMark {
  const m = readManifest(projectDir);
  const entry = m.certifications.find((e) => e.model === model && e.providerUrl === providerUrl);
  if (!entry) return "none";
  if (isStale(entry, currentVersion)) return "stale";
  return isFullyPassed(entry) ? "certified" : "none";
}
