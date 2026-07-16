import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { globSync } from 'node:fs';

const MEMORY_DIR = join(homedir(), '.mma', 'memory');
const MEMORY_FILES = ['project.md', 'conventions.md', 'decisions.md', 'errors.md', 'history.md'];

export interface MemoryEntry {
  type: string;
  date: string;
  title: string;
  content: string;
}

export function ensureMemoryDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

export function getMemoryPath(type: string): string {
  const fileMap: Record<string, string> = {
    project: 'project.md',
    conventions: 'conventions.md',
    decisions: 'decisions.md',
    errors: 'errors.md',
    history: 'history.md',
  };
  return join(MEMORY_DIR, fileMap[type] || `${type}.md`);
}

export function loadMemory(type: string): string {
  const path = getMemoryPath(type);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return `# ${type}\n\n_No entries yet._\n`;
  }
}

export function saveMemory(type: string, title: string, content: string): void {
  ensureMemoryDir();
  const path = getMemoryPath(type);
  const date = new Date().toISOString().split('T')[0];
  const entry = `\n## [${date}] ${title}\n${content}\n`;

  try {
    const existing = readFileSync(path, 'utf-8');
    writeFileSync(path, existing + entry, 'utf-8');
  } catch {
    writeFileSync(path, `# ${type}\n${entry}`, 'utf-8');
  }
}

export function searchMemory(query: string): { type: string; match: string }[] {
  const results: { type: string; match: string }[] = [];
  const lower = query.toLowerCase();

  for (const file of MEMORY_FILES) {
    const path = join(MEMORY_DIR, file);
    if (!existsSync(path)) continue;

    const type = file.replace('.md', '');
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        results.push({
          type,
          match: lines[i].trim().slice(0, 150),
        });
      }
    }
  }

  return results.slice(0, 20);
}

export function loadAllMemory(): string {
  ensureMemoryDir();
  const parts: string[] = [];

  for (const file of MEMORY_FILES) {
    const path = join(MEMORY_DIR, file);
    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf-8').trim();
    if (content && !content.includes('_No entries yet._')) {
      const title = file.replace('.md', '');
      const lines = content.split('\n').filter(l => l.startsWith('## ')).length;
      parts.push(`${title}: ${lines} entries`);
    }
  }

  if (parts.length === 0) return '';
  return `\n## Project Memory\n${parts.join('\n')}\n`;
}
