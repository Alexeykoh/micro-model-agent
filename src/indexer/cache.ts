import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateProjectMap, formatProjectMap, collectSourceFiles, setMaxFilesForProject, getMaxFilesForProject, extractExports, getLangKeyFromExt, type ProjectMap, type ProjectFile } from './project-map.js';
import { buildCodeIndex, formatCodeIndex, type CodeIndex } from './code-index.js';
import { logInfo, logWarn, logDebug, writeStatus } from '../logger.js';

const CACHE_DIR = join(homedir(), '.mma', 'index');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

const PROJECT_MAP_FILE = join(CACHE_DIR, 'project-map.txt');
const PROJECT_MAP_JSON = join(CACHE_DIR, 'project-map.json');
const CODE_INDEX_FILE = join(CACHE_DIR, 'code-index.json');
const CODE_INDEX_TXT = join(CACHE_DIR, 'code-index.txt');

export function loadCachedProjectMap(): { map: ProjectMap; formatted: string } | null {
  try {
    if (existsSync(PROJECT_MAP_JSON) && existsSync(PROJECT_MAP_FILE)) {
      const map = JSON.parse(readFileSync(PROJECT_MAP_JSON, 'utf-8')) as ProjectMap;
      const formatted = readFileSync(PROJECT_MAP_FILE, 'utf-8');
      return { map, formatted };
    }
  } catch { /* ignore */ }
  return null;
}

export function saveProjectMap(map: ProjectMap, formatted: string): void {
  ensureCacheDir();
  writeFileSync(PROJECT_MAP_JSON, JSON.stringify(map), 'utf-8');
  writeFileSync(PROJECT_MAP_FILE, formatted, 'utf-8');
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

let _projectMapCache: { map: ProjectMap; formatted: string } | null = null;
let _dirtyFiles = new Set<string>();

export function notifyFileChanged(relPath: string): void {
  if (relPath) _dirtyFiles.add(relPath);
}

function applyPendingUpdates(cache: { map: ProjectMap; formatted: string }, cwd: string): boolean {
  if (_dirtyFiles.size === 0) return false;

  writeStatus(`Updating ${_dirtyFiles.size} file(s)...`);
  logInfo('INDEXER', `applyPendingUpdates: ${_dirtyFiles.size} files`);
  let changed = false;

  for (const relPath of _dirtyFiles) {
    const absPath = join(cwd, relPath);

    if (!existsSync(absPath)) {
      const idx = cache.map.files.findIndex(f => f.path === relPath);
      if (idx !== -1) {
        cache.map.files.splice(idx, 1);
        changed = true;
      }
      continue;
    }

    try {
      const content = readFileSync(absPath, 'utf-8');
      const lines = content.split('\n').length;
      const ext = relPath.split('.').pop()?.toLowerCase() || '';
      const langKey = getLangKeyFromExt(ext);
      const exports = extractExports(content, langKey);

      const existing = cache.map.files.find(f => f.path === relPath);
      if (existing) {
        if (existing.lines !== lines || JSON.stringify(existing.exports) !== JSON.stringify(exports)) {
          existing.lines = lines;
          existing.exports = exports;
          changed = true;
        }
      } else {
        cache.map.files.push({ path: relPath, exports, lines });
        cache.map.files.sort((a, b) => a.path.localeCompare(b.path));
        changed = true;
      }
    } catch { /* skip unreadable */ }
  }

  _dirtyFiles.clear();

  if (changed) {
    cache.map.generatedAt = new Date().toISOString();
    cache.formatted = formatProjectMap(cache.map);
    saveProjectMap(cache.map, cache.formatted);
  }

  return changed;
}

export function getOrBuildProjectMap(cwd: string): { map: ProjectMap; formatted: string; fromCache: boolean } {
  if (_projectMapCache && _dirtyFiles.size === 0) {
    logDebug('INDEXER', 'getOrBuildProjectMap: memory cache hit');
    return { ..._projectMapCache, fromCache: true };
  }

  if (!_projectMapCache) {
    const cached = loadCachedProjectMap();
    if (cached) {
      logDebug('INDEXER', 'getOrBuildProjectMap: disk cache hit');
      _projectMapCache = { map: cached.map, formatted: cached.formatted };
    }
  }

  if (_projectMapCache) {
    const fromCache = _dirtyFiles.size === 0;
    applyPendingUpdates(_projectMapCache, cwd);
    return { ..._projectMapCache, fromCache };
  }

  writeStatus('Indexing project files...');
  logInfo('INDEXER', 'getOrBuildProjectMap: cache miss, building from scratch');
  const stored = getMaxFilesForProject(cwd);
  const max = stored ?? 5000;
  const map = generateProjectMap(cwd, max);
  const formatted = formatProjectMap(map);
  _projectMapCache = { map, formatted };
  _dirtyFiles.clear();
  saveProjectMap(map, formatted);
  writeStatus(`${map.files.length} files indexed`);
  return { map, formatted, fromCache: false };
}

export function checkProjectSize(cwd: string): number {
  return collectSourceFiles(cwd).length;
}

export function ensureMaxFiles(cwd: string, count: number): void {
  const stored = getMaxFilesForProject(cwd);
  if (stored) return;

  if (count > 5000) {
    logWarn('INDEXER', `${count} source files found. Use --max-files <N> or set in config agent.maxProjectFiles`);
    logInfo('INDEXER', `Indexing first 5000 files. Set maxProjectFiles in ~/.mma/config.json to index more.`);
  }
}

export function getOrBuildCodeIndex(cwd: string): { index: CodeIndex; formatted: string; fromCache: boolean } {
  const cached = loadCachedCodeIndex();
  if (cached) {
    logDebug('INDEXER', 'getOrBuildCodeIndex: disk cache hit');
    const formatted = formatCodeIndex(cached);
    return { index: cached, formatted, fromCache: true };
  }

  writeStatus('Building code index...');
  logInfo('INDEXER', 'getOrBuildCodeIndex: cache miss, building AST index');
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
  saveProjectMap(map, formatted);
  return { map, formatted };
}

export { setMaxFilesForProject } from './project-map.js';

export function updateIndexForFile(cwd: string, filePath: string): boolean {
  try {
    _projectMapCache = null;
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

  const builtAt = new Date(index.builtAt).getTime();
  const maxAge = 5 * 60 * 1000;

  return (Date.now() - builtAt) > maxAge;
}
