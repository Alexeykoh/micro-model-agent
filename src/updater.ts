import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MMA_DIR = join(homedir(), '.mma');
const CACHE_FILE = join(MMA_DIR, 'update-check.json');
const CACHE_TTL = 86_400_000; // 24h
const PKG_NAME = 'micro-models-agent';

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

export function getCurrentVersion(): string {
  const pkgPath = join(__dirname, '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function checkForUpdate(): { available: boolean; current: string; latest: string } {
  const current = getCurrentVersion();

  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
    return {
      available: isNewerVersion(current, cached.latestVersion),
      current,
      latest: cached.latestVersion,
    };
  }

  try {
    const stdout = execSync(`npm view ${PKG_NAME} version`, {
      timeout: 5000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const latest = stdout.trim();

    writeCache({ latestVersion: latest, checkedAt: Date.now() });

    return {
      available: isNewerVersion(current, latest),
      current,
      latest,
    };
  } catch {
    return { available: false, current, latest: current };
  }
}

function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return nb > na;
  }
  return false;
}

export function checkForUpdateAsync(): void {
  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
    return;
  }

  const current = getCurrentVersion();
  if (cached && !isNewerVersion(current, cached.latestVersion)) {
    // stale cache, force re-check
  }

  setTimeout(() => {
    try {
      const stdout = execSync(`npm view ${PKG_NAME} version`, {
        timeout: 5000,
        encoding: 'utf-8',
        windowsHide: true,
      });
      writeCache({ latestVersion: stdout.trim(), checkedAt: Date.now() });
    } catch { /* ignore */ }
  }, 100);
}

export function getUpdateCommand(): string {
  return `npm install -g ${PKG_NAME}`;
}

function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(data: UpdateCache): void {
  try {
    if (!existsSync(MMA_DIR)) mkdirSync(MMA_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch { /* ignore */ }
}
