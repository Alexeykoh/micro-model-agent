import { readFileSync, existsSync, statSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { countTokens } from './llm/token-counter.js';
import { getTheme } from './styling/index.js';
import { logInfo, logDebug } from './logger.js';

interface LoadedFile {
  path: string;
  content: string;
  tokens: number;
}

interface ParseResult {
  prompt: string;
  files: LoadedFile[];
}

const AT_REF_RE = /@([^\s"'|;]+)/g;

function resolveFileRef(ref: string): string[] {
  // Filter out URLs (http://, https://, ftp://) but allow Windows paths (E:\...)
  if (/^[a-z]+:\/\//i.test(ref)) {
    return [];
  }

  const globPattern = resolve(process.cwd(), ref);
  try {
    const matches = globSync(globPattern) as string[];
    if (matches.length > 0) return matches;
  } catch { /* not a glob */ }

  if (existsSync(ref)) return [ref];
  if (existsSync(resolve(process.cwd(), ref))) return [resolve(process.cwd(), ref)];

  return [];
}

function readFileRange(filePath: string, range?: string): string {
  const content = readFileSync(filePath, 'utf-8');
  if (!range) return content;

  const lines = content.split('\n');

  const rangeMatch = range.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    return lines.slice(Math.max(0, start - 1), end).join('\n');
  }

  const lineMatch = range.match(/^(\d+)$/);
  if (lineMatch) {
    const line = parseInt(lineMatch[1], 10);
    return lines[line - 1] ?? '';
  }

  return content;
}

function isBinaryFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    if (stats.size > 100 * 1024) return true;
    const buf = readFileSync(filePath);
    return buf.includes(0);
  } catch {
    return true;
  }
}

const MAX_FILE_SIZE = 50 * 1024;
const MAX_FILE_LINES = 2000;

export async function parseFileRefs(input: string): Promise<ParseResult> {
  const start = performance.now();
  const files: LoadedFile[] = [];
  const processed: Set<string> = new Set();

  let prompt = input;
  let match: RegExpExecArray | null;

  const re = new RegExp(AT_REF_RE.source, 'g');

  while ((match = re.exec(input)) !== null) {
    const ref = match[1];
    let filePath = ref;
    let range: string | undefined;
    let dirRef = false;

    if (ref.endsWith('/')) {
      dirRef = true;
      const dirPath = ref.slice(0, -1);
      const absolute = resolve(process.cwd(), dirPath);
      if (existsSync(absolute) && statSync(absolute).isDirectory()) {
        const dirFiles = globSync(`${absolute}/**/*.{ts,tsx,js,jsx,json,md}`) as string[];
        for (const f of dirFiles.slice(0, 20)) {
          if (!processed.has(f)) {
            processed.add(f);
          }
        }
        continue;
      }
    }

    if (filePath.includes(':')) {
      const colonIdx = filePath.indexOf(':');
      range = filePath.slice(colonIdx + 1);
      filePath = filePath.slice(0, colonIdx);
    }

    const resolved = resolveFileRef(filePath);
    for (const f of resolved) {
      if (processed.has(f)) continue;
      processed.add(f);

      if (isBinaryFile(f) || statSync(f).size > MAX_FILE_SIZE) {
        continue;
      }

      const content = readFileRange(f, range);

      const lines = content.split('\n');
      if (lines.length > MAX_FILE_LINES) {
        continue;
      }

      const tokens = await countTokens(content);
      files.push({ path: f, content, tokens });
    }
  }

  if (files.length > 0) {
    const theme = getTheme();
    const fileList = files.map(f => {
      const lines = f.content.split('\n').length;
      return theme.successMsg(`${theme.filePath(f.path)} (${lines} строк, ~${f.tokens} токенов)`);
    }).join('\n');

    const filesSection = files.map(f =>
      `\n### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
    ).join('\n');

    prompt = `${input}\n\n[Загруженные файлы:]\n${fileList}\n${filesSection}`;
  }

  const elapsed = (performance.now() - start).toFixed(1);
  if (files.length > 0) logInfo('FILELOADER', `parsed ${files.length} file refs in ${elapsed}ms`);
  logDebug('FILELOADER', `parseFileRefs done: ${elapsed}ms`);
  return { prompt, files };
}
