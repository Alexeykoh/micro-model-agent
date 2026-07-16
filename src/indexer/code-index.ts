import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.mma', 'dist', 'build', '__pycache__',
  'vendor', '.next', '.nuxt', 'coverage', '.cache', 'target',
  'out', '.output', '.turbo',
]);

interface SymbolInfo {
  file: string;
  line: number;
  type: string;
  sig: string;
}

interface ImportInfo {
  from: string;
  imports: string[];
}

interface ReferenceInfo {
  symbol: string;
  locations: string[];
}

export interface CodeIndex {
  language: string;
  symbols: Record<string, SymbolInfo>;
  imports: Record<string, ImportInfo>;
  references: Record<string, ReferenceInfo>;
  builtAt: string;
  fileHashes: Record<string, string>;
}

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:default\s+)?class\s+(\w+)/g,
    /export\s+(?:default\s+)?(?:type|interface)\s+(\w+)/g,
    /export\s+(?:default\s+)?enum\s+(\w+)/g,
    /export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/g,
  ],
  js: [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:default\s+)?class\s+(\w+)/g,
    /export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/g,
  ],
  py: [
    /^(?:class)\s+(\w+)/gm,
    /^(?:def)\s+(\w+)/gm,
  ],
  go: [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
    /^type\s+(\w+)\s+(?:struct|interface)/gm,
  ],
  rs: [
    /pub\s+fn\s+(\w+)/g,
    /pub\s+(?:struct|enum|trait|type)\s+(\w+)/g,
  ],
  java: [
    /(?:public|protected)\s+(?:class|interface|enum|abstract class)\s+(\w+)/g,
    /(?:public|protected)\s+(?:static\s+)?(?:final\s+)?(?:void|int|String|boolean|long|double|float)\s+(\w+)/g,
  ],
};

const IMPORT_PATTERNS: Record<string, RegExp> = {
  ts: /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g,
  js: /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g,
  py: /^(?:from\s+(\S+)\s+)?import\s+(.+)/gm,
  go: /import\s+(?:\("([^"]+)"\)|"([^"]+)")/g,
  rs: /use\s+([\w:]+)/g,
  java: /import\s+([\w.]+);/g,
};

function getLangKey(ext: string): string {
  if (ext === 'ts' || ext === 'tsx') return 'ts';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'js';
  return ext;
}

async function hashFile(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(content).digest('hex');
}

function extractSymbols(content: string, lang: string): { name: string; type: string; sig: string; line: number }[] {
  const symbols: { name: string; type: string; sig: string; line: number }[] = [];
  const patterns = SYMBOL_PATTERNS[lang] || SYMBOL_PATTERNS.ts;

  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      let type = 'function';
      if (match[0].includes('class')) type = 'class';
      else if (match[0].includes('type') || match[0].includes('interface')) type = 'type';
      else if (match[0].includes('enum')) type = 'enum';
      else if (match[0].includes('const') || match[0].includes('let') || match[0].includes('var')) type = 'const';

      const line = content.split('\n')[lineNum - 1]?.trim() || '';
      const sig = line.length > 100 ? line.slice(0, 97) + '...' : line;

      if (!symbols.some(s => s.name === name)) {
        symbols.push({ name, type, sig, line: lineNum });
      }
    }
  }
  return symbols;
}

function extractImports(content: string, lang: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const pattern = IMPORT_PATTERNS[lang];
  if (!pattern) return imports;

  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (lang === 'ts' || lang === 'js') {
      const named = match[1]?.split(',').map(s => s.trim()).filter(Boolean) || [];
      const def = match[2] ? [match[2]] : [];
      const from = match[3];
      if (from && (named.length > 0 || def.length > 0)) {
        imports.push({ from, imports: [...def, ...named] });
      }
    }
  }
  return imports;
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

export function buildCodeIndex(cwd: string): CodeIndex {
  const index: CodeIndex = {
    language: 'unknown',
    symbols: {},
    imports: {},
    references: {},
    builtAt: new Date().toISOString(),
    fileHashes: {},
  };

  const exts = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java'];
  const extensions = new Set(exts);

  let langCount: Record<string, number> = {};

  const filePaths: string[] = [];
  walkDir(cwd, cwd, extensions, filePaths);
  filePaths.sort();

  for (const rel of filePaths) {
    try {
      const content = readFileSync(join(cwd, rel), 'utf-8');
      const ext = rel.split('.').pop() || '';
      const lang = getLangKey(ext);
      langCount[lang] = (langCount[lang] || 0) + 1;

      index.fileHashes[rel] = content.length.toString();

      const symbols = extractSymbols(content, lang);
      for (const sym of symbols) {
        index.symbols[sym.name] = {
          file: rel,
          line: sym.line,
          type: sym.type,
          sig: sym.sig,
        };
      }

      const imports = extractImports(content, lang);
      if (imports.length > 0) {
        index.imports[rel] = imports[0];
      }
    } catch { /* skip */ }
  }

  index.language = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

  return index;
}

import { getTheme } from '../styling/index.js';

export function formatCodeIndex(index: CodeIndex): string {
  const theme = getTheme();
  const lines: string[] = [];
  lines.push(theme.heading(`CODE INDEX (${index.language})`));
  lines.push(theme.dim(`Symbols: ${Object.keys(index.symbols).length} | Files: ${Object.keys(index.fileHashes).length}`));
  lines.push('');

  const byType: Record<string, [string, SymbolInfo][]> = {};
  for (const [name, info] of Object.entries(index.symbols)) {
    const t = info.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push([name, info]);
  }

  for (const [type, syms] of Object.entries(byType).sort()) {
    lines.push(theme.bracket(type));
    for (const [name, info] of syms.slice(0, 30)) {
      lines.push(`  ${theme.symbolName(name)} ${theme.dim(theme.icon.arrow)} ${theme.filePath(info.file)}:${theme.lineNumbers(String(info.line))}`);
    }
    if (syms.length > 30) {
      lines.push(theme.dim(`  ... and ${syms.length - 30} more`));
    }
  }

  return lines.join('\n');
}

export function getCodeIndexTokenEstimate(index: CodeIndex): number {
  const text = formatCodeIndex(index);
  return Math.ceil(text.length / 4);
}
