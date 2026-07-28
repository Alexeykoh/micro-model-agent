import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Управление памятью агента.
 *
 * Память хранится в ~/.mma/memory/ в виде markdown-файлов:
 * - project.md — информация о проекте
 * - conventions.md — обнаруженные паттерны кодирования
 * - decisions.md — принятые решения
 * - errors.md — ошибки и их решения
 * - history.md — история действий
 *
 * Возможности:
 * - Поиск по записям (searchMemory)
 * - Компактификация при превышении бюджета токенов (trimMemoryToBudget)
 *
 * @module agent/memory
 */

// ─── Константы ──────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.mma', 'memory');
const MEMORY_FILES = ['project.md', 'conventions.md', 'decisions.md', 'errors.md', 'history.md'];
const ARCHIVE_DIR = join(MEMORY_DIR, 'archive');
const MAX_MEMORY_TOKENS = 2000; // максимальный бюджет токенов для памяти
const ARCHIVE_DAYS = 30; // дни хранения записей до архивации

/** Единица памяти агента */
export interface MemoryEntry {
  type: string;
  date: string;
  title: string;
  content: string;
}

/** Создаёт директорию памяти если не существует */
export function ensureMemoryDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

/**
 * Возвращает путь к файлу памяти по типу.
 * Маппит типы (project, conventions, decisions, errors, history)
 * на реальные имена файлов.
 */
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

/** Загружает содержимое файла памяти по типу */
export function loadMemory(type: string): string {
  const path = getMemoryPath(type);
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return `# ${type}\n\n_No entries yet._\n`;
  }
}

/** Добавляет новую запись в файл памяти */
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

/** Поиск по всем файлам памяти (регистронезависимый) */
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

/** Загружает краткую сводку по всем файлам памяти (для system prompt) */
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

/** Оценивает количество токенов в файлах памяти (~4 символа на токен) */
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

/**
 * Компактификация памяти при превышении бюджета токенов.
 * Удаляет 25% самых старых записей из каждого файла.
 *
 * @returns true если были удалены записи
 */
export function trimMemoryToBudget(): boolean {
  const estimate = getMemoryTokenEstimate();
  if (estimate <= MAX_MEMORY_TOKENS) return false;

  // Удаляем oldest 25% записей из каждого файла
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

/** Загружает детальную сводку по памяти (включая количество записей и токены) */
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
