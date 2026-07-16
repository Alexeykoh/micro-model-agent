import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEMORY_DIR = join(homedir(), '.mma', 'memory');
const MEMORY_FILES = ['project.md', 'conventions.md', 'decisions.md', 'errors.md', 'history.md'];
const ARCHIVE_DIR = join(MEMORY_DIR, 'archive');
const MAX_MEMORY_TOKENS = 2000;
const ARCHIVE_DAYS = 30;

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

export function removeMemoryEntry(type: string, lineNum: number): boolean {
  const path = getMemoryPath(type);
  if (!existsSync(path)) return false;

  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');

    // Find the ## entry that starts at or before lineNum
    let entryStart = -1;
    let entryEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        if (i + 1 <= lineNum) {
          entryStart = i;
        } else {
          entryEnd = i;
          break;
        }
      }
    }
    if (entryStart === -1) return false;
    if (entryEnd === -1) entryEnd = lines.length;

    // Remove the entry
    lines.splice(entryStart, entryEnd - entryStart);
    writeFileSync(path, lines.join('\n'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function exportMemory(): string | null {
  ensureMemoryDir();
  const parts: string[] = [];
  let hasContent = false;

  for (const file of MEMORY_FILES) {
    const path = join(MEMORY_DIR, file);
    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf-8').trim();
    if (content && !content.includes('_No entries yet._')) {
      parts.push(content);
      hasContent = true;
    }
  }

  if (!hasContent) return null;

  const exportPath = join(MEMORY_DIR, 'memory-export.md');
  writeFileSync(exportPath, parts.join('\n\n---\n\n'), 'utf-8');
  return exportPath;
}

export function autoLearnFromError(command: string, stderr: string, stdout: string): void {
  const errorText = stderr || stdout;
  if (!errorText || errorText.length < 10) return;

  const patterns: { re: RegExp; title: string; solution: string }[] = [
    { re: /Cannot find module\s+['"]([^'"]+)['"]/i, title: 'Missing module', solution: 'Install with npm install <module>' },
    { re: /ENOENT:\s+no such file or directory/i, title: 'File not found', solution: 'Check file path exists' },
    { re: /SyntaxError:\s+(.+)/i, title: 'Syntax error', solution: 'Fix syntax in the file' },
    { re: /TypeError:\s+(.+)/i, title: 'Type error', solution: 'Check types and null values' },
    { re: /ReferenceError:\s+(\w+)\s+is not defined/i, title: 'Undefined reference', solution: 'Import or define the variable' },
    { re: /EACCES:\s+permission denied/i, title: 'Permission denied', solution: 'Run with appropriate permissions' },
    { re: /EADDRINUSE:\s+address already in use/i, title: 'Port in use', solution: 'Kill process on that port or use different port' },
    { re: /Command failed:\s+(.+)/i, title: 'Command failed', solution: 'Check command syntax and dependencies' },
  ];

  for (const pattern of patterns) {
    const match = errorText.match(pattern.re);
    if (match) {
      const shortCmd = command.length > 60 ? command.slice(0, 57) + '...' : command;
      const shortErr = (match[1] || match[0]).toString().slice(0, 100);
      saveMemory('errors', `${pattern.title}: ${shortErr}`, `Command: \`${shortCmd}\`\nError: ${shortErr}\nSolution: ${pattern.solution}`);
      return;
    }
  }
}

export function autoLearnFromEdit(filePath: string, content: string): void {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const patterns: { re: RegExp; convention: string }[] = [
    { re: /export\s+default\s+function\s+(\w+)/, convention: 'Default export: function' },
    { re: /export\s+default\s+class\s+(\w+)/, convention: 'Default export: class' },
    { re: /export\s+(?:async\s+)?function\s+(\w+)/, convention: 'Named function export' },
    { re: /export\s+const\s+(\w+)\s*=\s*(?:async\s+)?\(/, convention: 'Arrow function export' },
    { re: /export\s+(?:type|interface)\s+(\w+)/, convention: 'Type export' },
    { re: /import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/, convention: 'Named imports' },
    { re: /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/, convention: 'Default import' },
    { re: /console\.(log|error|warn)\(/, convention: 'Console output (consider using logger)' },
    { re: /try\s*\{[\s\S]*?\}\s*catch\s*\(/, convention: 'Error handling pattern' },
  ];

  const detected: string[] = [];
  for (const p of patterns) {
    if (p.re.test(content)) {
      detected.push(p.convention);
    }
  }

  if (detected.length > 0) {
    const unique = [...new Set(detected)];
    saveMemory('conventions', `Patterns in ${filePath}`, unique.join('\n'));
  }
}

export function getMemoryTokenEstimate(): number {
  let totalChars = 0;
  for (const file of MEMORY_FILES) {
    const path = join(MEMORY_DIR, file);
    if (!existsSync(path)) continue;
    try {
      totalChars += readFileSync(path, 'utf-8').length;
    } catch { /* ignore */ }
  }
  return Math.ceil(totalChars / 4);
}

export function trimMemoryToBudget(): boolean {
  const estimate = getMemoryTokenEstimate();
  if (estimate <= MAX_MEMORY_TOKENS) return false;

  // Remove oldest entries from each file until under budget
  for (const file of MEMORY_FILES) {
    const path = join(MEMORY_DIR, file);
    if (!existsSync(path)) continue;

    try {
      let content = readFileSync(path, 'utf-8');
      const entries = content.split(/\n(?=## \[)/);
      if (entries.length <= 2) continue;

      // Remove oldest entries (skip header)
      const header = entries[0];
      const body = entries.slice(1);
      body.splice(0, Math.ceil(body.length / 4)); // Remove 25% oldest
      writeFileSync(path, header + body.join(''), 'utf-8');
    } catch { /* ignore */ }
  }

  return getMemoryTokenEstimate() < estimate;
}

export function loadAllMemoryDetailed(): string {
  ensureMemoryDir();
  const parts: string[] = [];
  let totalChars = 0;

  for (const file of MEMORY_FILES) {
    const path = join(MEMORY_DIR, file);
    if (!existsSync(path)) continue;

    const content = readFileSync(path, 'utf-8').trim();
    if (content && !content.includes('_No entries yet._')) {
      const title = file.replace('.md', '');
      const entries = content.split(/\n(?=## \[)/).length - 1;
      totalChars += content.length;
      parts.push(`${title}: ${entries} entries`);
    }
  }

  if (parts.length === 0) return '';
  const tokens = Math.ceil(totalChars / 4);
  return `\n## Project Memory (${tokens} tokens)\n${parts.join('\n')}\n`;
}
