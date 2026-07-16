import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.mma', 'dist', 'build', '__pycache__',
  'vendor', '.next', '.nuxt', 'coverage', '.cache', 'target',
  'out', '.output', '.turbo',
]);

const EXT_MAP: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java',
  rb: 'rb', php: 'php', c: 'c', cpp: 'c', h: 'c', hpp: 'c',
};

const EXPORT_PATTERNS: Record<string, RegExp> = {
  ts: /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|type|interface|enum|const|let|var)\s+(\w+)/g,
  js: /export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g,
  py: /^(?:class|def)\s+(\w+)/gm,
  go: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
  rs: /pub\s+(?:fn|struct|enum|trait|type|const|static)\s+(\w+)/g,
  java: /(?:public|protected)\s+(?:class|interface|enum|abstract class)\s+(\w+)/g,
  rb: /(?:class|def|module)\s+(\w+)/g,
  php: /(?:class|interface|enum|function)\s+(\w+)/g,
  c: /(?:void|int|char|bool|float|double|unsigned|static|extern|inline)\s+(\w+)\s*\(/g,
};

const CONFIG_FILES: Record<string, string> = {
  'package.json': 'ts',
  'pyproject.toml': 'py',
  'setup.py': 'py',
  'requirements.txt': 'py',
  'go.mod': 'go',
  'Cargo.toml': 'rs',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'Gemfile': 'rb',
  'composer.json': 'php',
  'CMakeLists.txt': 'c',
  'Makefile': 'c',
};

function detectLanguage(cwd: string): string[] {
  const langs: string[] = [];
  for (const [configFile, lang] of Object.entries(CONFIG_FILES)) {
    if (existsSync(join(cwd, configFile))) {
      if (!langs.includes(lang)) langs.push(lang);
    }
  }
  if (langs.length === 0) {
    langs.push('ts', 'js', 'py', 'go', 'rs', 'java');
  }
  return langs;
}

function walkDir(dir: string, baseDir: string, extensions: Set<string>, results: string[]): void {
  let entries: any[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, extensions, results);
    } else if (entry.isFile()) {
      const ext = entry.name.split('.').pop()?.toLowerCase() || '';
      if (extensions.has(ext)) {
        const rel = fullPath.slice(baseDir.length + 1).replace(/\\/g, '/');
        results.push(rel);
      }
    }
  }
}

function extractExports(content: string, lang: string): string[] {
  const exports: string[] = [];
  const pattern = EXPORT_PATTERNS[lang];
  if (!pattern) return exports;

  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[1] && !exports.includes(match[1])) {
      exports.push(match[1]);
    }
  }
  return exports;
}

export interface ProjectFile {
  path: string;
  exports: string[];
  lines: number;
}

export interface ProjectMap {
  projectName: string;
  files: ProjectFile[];
  generatedAt: string;
}

export function generateProjectMap(cwd: string): ProjectMap {
  let projectName = 'unknown';
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try { projectName = JSON.parse(readFileSync(pkgPath, 'utf-8')).name || projectName; } catch { /* ignore */ }
  } else {
    projectName = basename(cwd);
  }

  const langs = detectLanguage(cwd);
  const extensions = new Set<string>();
  for (const lang of langs) {
    for (const [ext, langKey] of Object.entries(EXT_MAP)) {
      if (langKey === lang) extensions.add(ext);
    }
  }

  const filePaths: string[] = [];
  walkDir(cwd, cwd, extensions, filePaths);
  filePaths.sort();

  const allFiles: ProjectFile[] = [];
  for (const rel of filePaths) {
    try {
      const content = readFileSync(join(cwd, rel), 'utf-8');
      const lines = content.split('\n').length;
      const ext = rel.split('.').pop()?.toLowerCase() || '';
      const langKey = EXT_MAP[ext] || ext;
      const exports = extractExports(content, langKey);
      allFiles.push({ path: rel, exports, lines });
    } catch { /* skip unreadable */ }
  }

  return {
    projectName,
    files: allFiles,
    generatedAt: new Date().toISOString(),
  };
}

export function formatProjectMap(map: ProjectMap): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${map.projectName}`);
  lines.push(`Files: ${map.files.length} | Generated: ${map.generatedAt}`);
  lines.push('');

  let currentDir = '';
  for (const file of map.files) {
    const parts = file.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    if (dir !== currentDir) {
      if (currentDir !== '') lines.push('');
      lines.push(`├── ${dir}/`);
      currentDir = dir;
    }

    const name = parts[parts.length - 1];
    const expStr = file.exports.length > 0 ? `  exports: ${file.exports.join(', ')}` : '';
    lines.push(`│   ├── ${name}${expStr}`);
  }

  return lines.join('\n');
}

export function getProjectMapTokenEstimate(map: ProjectMap): number {
  const text = formatProjectMap(map);
  return Math.ceil(text.length / 4);
}
