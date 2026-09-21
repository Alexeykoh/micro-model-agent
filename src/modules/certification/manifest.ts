import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { CertManifest, CertificationEntry, CertMark } from "./types";

export function manifestPath(projectDir: string): string {
  return join(projectDir, "certification", "certifications.json");
}

/** Directory of the global (per-user) manifest. Overridable for tests. */
export function globalManifestDir(override?: string): string {
  return override || process.env.MMA_CERT_HOME || join(homedir(), ".mma");
}

export function globalManifestPath(override?: string): string {
  return join(globalManifestDir(override), "certifications.json");
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

export function readGlobalManifest(override?: string): CertManifest {
  const path = globalManifestPath(override);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as CertManifest;
      return { version: 1, certifications: raw.certifications ?? [] };
    }
  } catch {
    /* corrupted global manifest → start fresh */
  }
  return { version: 1, certifications: [] };
}

export function saveGlobalManifest(m: CertManifest, override?: string): void {
  const dir = globalManifestDir(override);
  mkdirSync(dir, { recursive: true });
  writeFileSync(globalManifestPath(override), JSON.stringify(m, null, 2), "utf-8");
}

const certKey = (e: CertificationEntry): string => `${e.model}::${e.providerUrl}`;

/**
 * Global + project manifests merged by (model, providerUrl). The NEWER entry
 * wins (by mmaVersion, then certifiedAt); a legacy project manifest no longer
 * shadows a fresher global certification.
 */
export function readMergedManifest(projectDir: string, override?: string): CertManifest {
  const merged = new Map<string, CertificationEntry>();
  for (const e of readGlobalManifest(override).certifications) merged.set(certKey(e), e);
  for (const e of readManifest(projectDir).certifications) {
    const key = certKey(e);
    const existing = merged.get(key);
    if (!existing || isEntryNewer(e, existing)) merged.set(key, e);
  }
  return { version: 1, certifications: [...merged.values()] };
}

export function upsertCertification(
  entry: CertificationEntry,
  override?: string,
): CertManifest {
  const m = readGlobalManifest(override);
  const idx = m.certifications.findIndex((e) => certKey(e) === certKey(entry));
  if (idx >= 0) m.certifications[idx] = entry;
  else m.certifications.push(entry);
  saveGlobalManifest(m, override);
  return m;
}

export function removeCertification(
  model: string,
  providerUrl: string,
  opts?: { globalDir?: string; projectDir?: string },
): { global: boolean; project: boolean } {
  const key = `${model}::${providerUrl}`;
  const g = readGlobalManifest(opts?.globalDir);
  const beforeG = g.certifications.length;
  g.certifications = g.certifications.filter((e) => certKey(e) !== key);
  const removedGlobal = g.certifications.length !== beforeG;
  if (removedGlobal) saveGlobalManifest(g, opts?.globalDir);

  // Legacy per-project manifests may still hold the entry — clean those too.
  let removedProject = false;
  try {
    const projectDir = opts?.projectDir ?? process.cwd();
    const p = readManifest(projectDir);
    const beforeP = p.certifications.length;
    p.certifications = p.certifications.filter((e) => certKey(e) !== key);
    if (p.certifications.length !== beforeP) {
      saveManifest(p, projectDir);
      removedProject = true;
    }
  } catch {
    /* no project manifest — fine */
  }
  return { global: removedGlobal, project: removedProject };
}

export function isStale(entry: CertificationEntry, currentVersion: string): boolean {
  return entry.mmaVersion !== currentVersion;
}

/** Numeric semver-ish comparison; non-numeric/missing parts count as 0. */
function compareVersions(a: string, b: string): number {
  const pa = String(a ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Is `candidate` genuinely newer than `current` (by mmaVersion, then
 * certifiedAt)? Used to avoid downgrading a fresher certification — both when
 * syncing the bundled manifest and when merging the legacy project manifest.
 */
function isEntryNewer(candidate: CertificationEntry, current: CertificationEntry): boolean {
  const v = compareVersions(candidate.mmaVersion, current.mmaVersion);
  if (v !== 0) return v > 0;
  const ec = Date.parse(candidate.certifiedAt ?? "");
  const ee = Date.parse(current.certifiedAt ?? "");
  if (!Number.isNaN(ec) && !Number.isNaN(ee)) return ec > ee;
  return false;
}

export function isFullyPassed(entry: CertificationEntry): boolean {
  return entry.suite.failed === 0 && entry.suite.passed > 0;
}

export function getCertMark(
  model: string,
  providerUrl: string,
  currentVersion: string,
  projectDir: string,
  globalOverride?: string,
): CertMark {
  const m = readMergedManifest(projectDir, globalOverride);
  const entry = m.certifications.find((e) => e.model === model && e.providerUrl === providerUrl);
  if (!entry) return "none";
  if (isStale(entry, currentVersion)) return "stale";
  return isFullyPassed(entry) ? "certified" : "none";
}

/** Snapshot file marking which bundled manifest was last synced to the global one. */
function syncSnapshotPath(override?: string): string {
  return join(globalManifestDir(override), "certifications.synced.json");
}

/**
 * Locate the certifications.json bundled with the installed MMA package.
 * - dist/main.js layout: <dist>/certification/certifications.json (copied by copy-assets)
 * - source layout:       <repo-root>/certification/certifications.json
 */
export function bundledManifestPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "certification", "certifications.json"),
    join(here, "..", "certification", "certifications.json"),
    join(here, "..", "..", "..", "certification", "certifications.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Sync the bundled (shipped-with-package) manifest into the global
 * ~/.mma/certifications.json. Runs once per process start:
 * the bundled file overwrites its own entries on every package update;
 * user-local certifications for OTHER keys are preserved. A snapshot of the
 * raw bundled content marks what was already synced, so nothing is rewritten
 * between updates.
 */
export function syncGlobalManifest(
  override?: string,
  bundledPathOverride?: string,
): { synced: boolean; reason: "no-bundled" | "unchanged" | "synced" | "error" } {
  try {
    const bundledPath = bundledPathOverride ?? bundledManifestPath();
    if (!bundledPath || !existsSync(bundledPath)) return { synced: false, reason: "no-bundled" };
    const raw = readFileSync(bundledPath, "utf-8");
    const snapshotPath = syncSnapshotPath(override);
    if (existsSync(snapshotPath) && readFileSync(snapshotPath, "utf-8") === raw) {
      return { synced: false, reason: "unchanged" };
    }
    const bundled = JSON.parse(raw) as CertManifest;
    const current = readGlobalManifest(override);
    const merged = new Map<string, CertificationEntry>();
    for (const e of current.certifications) merged.set(certKey(e), e);
    for (const e of bundled.certifications ?? []) {
      const key = certKey(e);
      const existing = merged.get(key);
      // Не перезаписываем более свежую пользовательскую сертификацию старой
      // bundled-копией (иначе запуск CLI затирает только что сделанный certify).
      if (existing && !isEntryNewer(e, existing)) continue;
      merged.set(key, e);
    }
    saveGlobalManifest({ version: 1, certifications: [...merged.values()] }, override);
    mkdirSync(globalManifestDir(override), { recursive: true });
    writeFileSync(snapshotPath, raw, "utf-8");
    return { synced: true, reason: "synced" };
  } catch {
    return { synced: false, reason: "error" };
  }
}
