import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { CertManifest, CertificationEntry, CertMark } from "./types";

export const MANIFEST_PATH = join(homedir(), ".mma", "certifications.json");

export function readManifest(path: string = MANIFEST_PATH): CertManifest {
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

export function saveManifest(m: CertManifest, path: string = MANIFEST_PATH): void {
  mkdirSync(join(homedir(), ".mma"), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2), "utf-8");
}

export function upsertCertification(
  entry: CertificationEntry,
  path: string = MANIFEST_PATH,
): CertManifest {
  const m = readManifest(path);
  const idx = m.certifications.findIndex(
    (e) => e.model === entry.model && e.providerUrl === entry.providerUrl,
  );
  if (idx >= 0) m.certifications[idx] = entry;
  else m.certifications.push(entry);
  saveManifest(m, path);
  return m;
}

export function removeCertification(
  model: string,
  providerUrl: string,
  path: string = MANIFEST_PATH,
): boolean {
  const m = readManifest(path);
  const before = m.certifications.length;
  m.certifications = m.certifications.filter(
    (e) => !(e.model === model && e.providerUrl === providerUrl),
  );
  if (m.certifications.length !== before) {
    saveManifest(m, path);
    return true;
  }
  return false;
}

export function isStale(entry: CertificationEntry, currentVersion: string): boolean {
  return entry.mmaVersion !== currentVersion;
}

export function getCertMark(
  model: string,
  providerUrl: string,
  currentVersion: string,
  path: string = MANIFEST_PATH,
): CertMark {
  const m = readManifest(path);
  const entry = m.certifications.find((e) => e.model === model && e.providerUrl === providerUrl);
  if (!entry) return "none";
  return isStale(entry, currentVersion) ? "stale" : "certified";
}
