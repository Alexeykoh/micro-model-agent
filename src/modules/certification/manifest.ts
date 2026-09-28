// Манифест сертификации: проектный и глобальный (per-user) файлы, мерж и синк bundled-копии.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { CertManifest, CertificationEntry, CertMark } from "./types";
import { MMA_DIR_NAME } from "../../config/paths";

/** Путь к проектному манифесту внутри каталога проекта. */
export function manifestPath(projectDir: string): string {
  return join(projectDir, "certification", "certifications.json");
}

/** Каталог глобального (per-user) манифеста. Переопределяется для тестов. */
export function globalManifestDir(override?: string): string {
  return override || process.env.MMA_CERT_HOME || join(homedir(), MMA_DIR_NAME);
}

/** Путь к глобальному манифесту. */
export function globalManifestPath(override?: string): string {
  return join(globalManifestDir(override), "certifications.json");
}

/** Читает проектный манифест; битый/отсутствующий даёт пустой. */
export function readManifest(projectDir: string): CertManifest {
  const path = manifestPath(projectDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as CertManifest;
      return { version: 1, certifications: raw.certifications ?? [] };
    }
  } catch {
    /* битый манифест → начинаем с чистого */
  }
  return { version: 1, certifications: [] };
}

/** Сохраняет проектный манифест (каталог создаётся). */
export function saveManifest(m: CertManifest, projectDir: string): void {
  const path = manifestPath(projectDir);
  mkdirSync(join(projectDir, "certification"), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2), "utf-8");
}

/** Читает глобальный манифест; битый/отсутствующий даёт пустой. */
export function readGlobalManifest(override?: string): CertManifest {
  const path = globalManifestPath(override);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as CertManifest;
      return { version: 1, certifications: raw.certifications ?? [] };
    }
  } catch {
    /* битый глобальный манифест → начинаем с чистого */
  }
  return { version: 1, certifications: [] };
}

/** Сохраняет глобальный манифест. */
export function saveGlobalManifest(m: CertManifest, override?: string): void {
  const dir = globalManifestDir(override);
  mkdirSync(dir, { recursive: true });
  writeFileSync(globalManifestPath(override), JSON.stringify(m, null, 2), "utf-8");
}

const certKey = (e: CertificationEntry): string => `${e.model}::${e.providerUrl}`;

/**
 * Глобальный + проектный манифесты, сведённые по (model, providerUrl). Побеждает
 * БОЛЕЕ НОВАЯ запись (сначала mmaVersion, затем certifiedAt); легаси-проектный
 * манифест свежую глобальную сертификацию больше не затеняет.
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

/**
 * Добавляет/обновляет запись в глобальном манифесте по ключу (model, providerUrl).
 * Возвращает обновлённый манифест.
 */
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

/**
 * Удаляет запись из глобального и легаси-проектного манифестов.
 * Возвращает флаги, откуда реально удалили.
 */
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

  // В легаси-проектных манифестах запись могла остаться — чистим и их.
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
    /* проектного манифеста нет — нормально */
  }
  return { global: removedGlobal, project: removedProject };
}

/** True, если запись сделана не на текущей версии MMA (протухла). */
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
 * Действительно ли `candidate` новее `current` (сначала mmaVersion, затем
 * certifiedAt)? Защита от даунгрейда свежей сертификации — и при синке
 * bundled-манифеста, и при мерже легаси-проектного.
 */
function isEntryNewer(candidate: CertificationEntry, current: CertificationEntry): boolean {
  const v = compareVersions(candidate.mmaVersion, current.mmaVersion);
  if (v !== 0) return v > 0;
  const ec = Date.parse(candidate.certifiedAt ?? "");
  const ee = Date.parse(current.certifiedAt ?? "");
  if (!Number.isNaN(ec) && !Number.isNaN(ee)) return ec > ee;
  return false;
}

/** True, если в записи нет провалов и есть хоть один пройденный сценарий. */
export function isFullyPassed(entry: CertificationEntry): boolean {
  return entry.suite.failed === 0 && entry.suite.passed > 0;
}

/**
 * Метка модели: `certified` (всё прошло на текущей версии), `stale` (запись от
 * старой версии) или `none` (нет записи / есть провалы).
 */
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
 * Ищет certifications.json, упакованный в установленный пакет MMA.
 * - бандл dist/main.js: <dist>/certification/certifications.json (копирует copy-assets)
 * - исходники:          <repo-root>/certification/certifications.json
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
 * Вливает упакованный (поставляемый с пакетом) манифест в глобальный
 * ~/.mma/certifications.json. Работает раз на старт процесса:
 * bundled-файл при каждом обновлении пакета перезаписывает СВОИ записи;
 * пользовательские сертификации под ДРУГИМИ ключами сохраняются. Снапшот
 * сырого bundled-содержимого фиксирует, что уже синкнуто, чтобы между
 * обновлениями ничего не переписывать.
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
