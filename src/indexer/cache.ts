import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateProjectMap, formatProjectMap, type ProjectMap } from './project-map.js';
import { buildCodeIndex, formatCodeIndex, type CodeIndex } from './code-index.js';

const CACHE_DIR = join(homedir(), '.mma', 'index');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

const PROJECT_MAP_FILE = join(CACHE_DIR, 'project-map.txt');
const CODE_INDEX_FILE = join(CACHE_DIR, 'code-index.json');
const CODE_INDEX_TXT = join(CACHE_DIR, 'code-index.txt');

export function loadCachedProjectMap(): string | null {
  try {
    if (existsSync(PROJECT_MAP_FILE)) {
      return readFileSync(PROJECT_MAP_FILE, 'utf-8');
    }
  } catch { /* ignore */ }
  return null;
}

export function saveProjectMap(map: string): void {
  ensureCacheDir();
  writeFileSync(PROJECT_MAP_FILE, map, 'utf-8');
}

export function loadCachedCodeIndex(): CodeIndex | null {
  try {
    if (existsSync(CODE_INDEX_FILE)) {
      return JSON.parse(readFileSync(CODE_INDEX_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

export function saveCodeIndex(index: CodeIndex): void {
  ensureCacheDir();
  writeFileSync(CODE_INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
  writeFileSync(CODE_INDEX_TXT, formatCodeIndex(index), 'utf-8');
}

export function getOrBuildProjectMap(cwd: string): { map: ProjectMap; formatted: string; fromCache: boolean } {
  const cached = loadCachedProjectMap();
  if (cached) {
    const map = generateProjectMap(cwd);
    return { map, formatted: cached, fromCache: true };
  }

  const map = generateProjectMap(cwd);
  const formatted = formatProjectMap(map);
  saveProjectMap(formatted);
  return { map, formatted, fromCache: false };
}

export function getOrBuildCodeIndex(cwd: string): { index: CodeIndex; formatted: string; fromCache: boolean } {
  const cached = loadCachedCodeIndex();
  if (cached) {
    const formatted = formatCodeIndex(cached);
    return { index: cached, formatted, fromCache: true };
  }

  const index = buildCodeIndex(cwd);
  const formatted = formatCodeIndex(index);
  saveCodeIndex(index);
  return { index, formatted, fromCache: false };
}

export function rebuildCodeIndex(cwd: string): { index: CodeIndex; formatted: string } {
  const index = buildCodeIndex(cwd);
  const formatted = formatCodeIndex(index);
  saveCodeIndex(index);
  return { index, formatted };
}

export function rebuildProjectMap(cwd: string): { map: ProjectMap; formatted: string } {
  const map = generateProjectMap(cwd);
  const formatted = formatProjectMap(map);
  saveProjectMap(formatted);
  return { map, formatted };
}

export function updateIndexForFile(cwd: string, filePath: string): boolean {
  try {
    const fullIndex = buildCodeIndex(cwd);
    saveCodeIndex(fullIndex);
    return true;
  } catch {
    return false;
  }
}

export function isIndexStale(cwd: string): boolean {
  const index = loadCachedCodeIndex();
  if (!index) return true;

  // Check if any source files have changed since index was built
  const builtAt = new Date(index.builtAt).getTime();
  const maxAge = 5 * 60 * 1000; // 5 minutes

  return (Date.now() - builtAt) > maxAge;
}
