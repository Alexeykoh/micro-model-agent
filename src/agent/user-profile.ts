import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, version as osVersion, hostname } from 'node:os';

const USER_DIR = join(homedir(), '.mma', 'user');
const PROFILE_FILE = join(USER_DIR, 'profile.md');
const COUNTER_FILE = join(USER_DIR, '.counter');
const STALE_DAYS = 30;

type Section =
  | 'OS'
  | 'Tech Stack'
  | 'Coding Style'
  | 'Session Patterns'
  | 'Notes';

export function ensureUserDir(): void {
  if (!existsSync(USER_DIR)) mkdirSync(USER_DIR, { recursive: true });
}

export function loadProfile(): string {
  ensureUserDir();
  try {
    return readFileSync(PROFILE_FILE, 'utf-8');
  } catch {
    return '';
  }
}

export function profileExists(): boolean {
  ensureUserDir();
  return existsSync(PROFILE_FILE);
}

function getProfile(): string {
  ensureUserDir();
  try {
    return readFileSync(PROFILE_FILE, 'utf-8');
  } catch {
    return '# User Profile\n';
  }
}

function writeProfile(content: string): void {
  ensureUserDir();
  writeFileSync(PROFILE_FILE, content, 'utf-8');
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

function daysAgo(dateStr: string): number {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function stripDate(line: string): string {
  return line.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '- ').trim();
}

function hasDate(line: string): boolean {
  return /^-\s*\[\d{4}-\d{2}-\d{2}\]/.test(line);
}

/**
 * Добавляет или обновляет запись в секции.
 * Если запись с таким же содержимым (без учёта даты) уже существует —
 * обновляет её дату (версия повышается). Иначе добавляет новую с сегодняшней датой.
 */
export function upsertEntry(section: string, content: string): void {
  let profile = getProfile();
  const sectionHeader = `## ${section}`;
  const date = today();
  const newLine = `- [${date}] ${content}`;

  const sectionIdx = profile.indexOf(sectionHeader);
  if (sectionIdx === -1) {
    profile += `\n${sectionHeader}\n${newLine}\n`;
    writeProfile(profile);
    return;
  }

  const sectionEnd = profile.indexOf('\n## ', sectionIdx + 1);
  const secStart = sectionIdx + sectionHeader.length + 1;
  const secEnd = sectionEnd === -1 ? profile.length : sectionEnd;
  const before = profile.slice(0, secStart);
  const after = profile.slice(secEnd);
  const sectionBody = profile.slice(secStart, secEnd);

  const lines = sectionBody.split('\n').filter(l => l.trim());
  const strippedNew = stripDate(newLine);
  let found = false;
  const updated = lines.map(line => {
    if (hasDate(line) && stripDate(line) === strippedNew) {
      found = true;
      return newLine;
    }
    return line;
  });

  if (!found) updated.push(newLine);

  writeProfile(before + '\n' + updated.join('\n') + '\n' + after);
}

export function appendNote(note: string, section: Section = 'Notes'): void {
  upsertEntry(section, note);
}

export function collectOS(): void {
  const existing = loadProfile();
  if (existing.includes('## OS')) return;

  let osVer = platform();
  try { osVer += ` (${osVersion()})`; } catch {}

  upsertEntry('OS', `Platform: ${platform()}`);
  upsertEntry('OS', `Version: ${osVer}`);
  upsertEntry('OS', `Hostname: ${hostname()}`);
  upsertEntry('OS', `Node.js: ${process.version}`);
}

export function collectTechStack(): void {
  const pkgPath = join(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) return;

  let pkg: any;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); } catch { return; }

  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const depNames = Object.keys(allDeps);

  const techCategories: Record<string, string[]> = {
    Runtime: ['node', 'bun', 'deno'],
    Framework: ['next', 'remix', 'nuxt', 'astro', 'svelte', 'vue', 'angular', 'express', 'fastify', 'hono', 'nest'],
    UI: ['react', 'preact', 'solid', 'lit'],
    Styling: ['tailwind', 'sass', 'less', 'styled-components', 'emotion', 'css-modules'],
    Database: ['prisma', 'drizzle', 'typeorm', 'mongoose', 'sequelize', 'knex', 'pg', 'mysql', 'sqlite'],
    Build: ['vite', 'webpack', 'esbuild', 'rollup', 'parcel', 'turbo'],
    Testing: ['vitest', 'jest', 'mocha', 'cypress', 'playwright', 'testing-library'],
    Lint: ['eslint', 'prettier', 'biome'],
  };

  for (const dep of depNames) {
    let categorized = false;
    for (const [category, keywords] of Object.entries(techCategories)) {
      if (keywords.some(k => dep.toLowerCase().includes(k))) {
        upsertEntry('Tech Stack', `${dep} (${category})`);
        categorized = true;
        break;
      }
    }
    if (!categorized && !dep.startsWith('@types/') && !dep.startsWith('typescript') && !dep.startsWith('@')) {
      upsertEntry('Tech Stack', dep);
    }
  }
}

export function collectCodingStyle(filePath: string, content: string): void {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return;

  const lines = content.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  if (nonEmptyLines.length < 3) return;

  const indentLines = nonEmptyLines.filter(l => l[0] === ' ' || l[0] === '\t');
  if (indentLines.length > 0) {
    const firstIndent = indentLines[0];
    if (firstIndent[0] === '\t') {
      upsertEntry('Coding Style', 'Индентация: табуляция');
    } else {
      const spaceCount = firstIndent.search(/\S/);
      upsertEntry('Coding Style', `Индентация: ${spaceCount} пробела`);
    }
  }

  const singleQ = lines.filter(l => l.includes("'") && !l.includes('"'));
  const doubleQ = lines.filter(l => l.includes('"') && !l.includes("'"));
  if (singleQ.length > doubleQ.length * 1.5) {
    upsertEntry('Coding Style', 'Кавычки: одинарные');
  } else if (doubleQ.length > singleQ.length * 1.5) {
    upsertEntry('Coding Style', 'Кавычки: двойные');
  }

  const semiLines = lines.filter(l => l.trim().endsWith(';') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'));
  const noSemiLines = lines.filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.endsWith(';') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('import') && !t.startsWith('export') && !t.startsWith('{') && !t.startsWith('}') && !t.startsWith('(') && !t.endsWith('{') && !t.endsWith('}') && !t.endsWith(',');
  });
  if (semiLines.length > noSemiLines.length * 2) {
    upsertEntry('Coding Style', 'Точки с запятой: да');
  } else if (noSemiLines.length > semiLines.length * 2) {
    upsertEntry('Coding Style', 'Точки с запятой: нет');
  }
}

export function collectSessionStart(): void {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('ru-RU');
  upsertEntry('Session Patterns', `Сессия начата: ${dateStr} ${timeStr}`);

  let counter = 1;
  try {
    if (existsSync(COUNTER_FILE)) {
      counter = parseInt(readFileSync(COUNTER_FILE, 'utf-8').trim(), 10) + 1;
    }
  } catch {}
  try { writeFileSync(COUNTER_FILE, String(counter), 'utf-8'); } catch {}
}

export function sessionEnded(): void {
  const timeStr = new Date().toLocaleTimeString('ru-RU');
  upsertEntry('Session Patterns', `Сессия завершена: ${timeStr}`);
}

/**
 * Формирует блок для system prompt с учётом версионности.
 * Записи старше STALE_DAYS помечаются как (stale Nd ago).
 * Секция Notes исключается.
 */
export function loadProfileSummary(): string {
  const profile = loadProfile();
  if (!profile) return '';

  const lines = profile.split('\n');
  const sections: string[] = [];
  let currentSection = '';
  let items: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection && currentSection !== 'Notes' && items.length > 0) {
        sections.push(`  ${currentSection}: ${items.join(', ')}`);
      }
      currentSection = line.replace('## ', '').trim();
      items = [];
    } else if (line.startsWith('- ') && currentSection && currentSection !== 'Notes') {
      const hasDatePrefix = hasDate(line);
      let val: string;
      let ageDays = Infinity;

      if (hasDatePrefix) {
        const match = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.*)/);
        if (match) {
          val = match[2].trim();
          ageDays = daysAgo(match[1]);
        } else {
          val = line.replace('- ', '').trim();
        }
      } else {
        val = line.replace('- ', '').trim();
      }

      if (ageDays > STALE_DAYS && ageDays !== Infinity) {
        val += ` (stale ${ageDays}d ago)`;
      }
      items.push(val);
    }
  }
  if (currentSection && currentSection !== 'Notes' && items.length > 0) {
    sections.push(`  ${currentSection}: ${items.join(', ')}`);
  }

  if (sections.length === 0) return '';

  const instruction = 'Учитывай эти наблюдения при выборе стека, стиля кода и формата ответа. Если заметил новую деталь — добавь через user_profile.';

  return `\n## User Profile\n${sections.join('\n')}\n${instruction}\n`;
}

export function initDefaultProfile(): void {
  ensureUserDir();
  if (existsSync(PROFILE_FILE)) return;
  writeProfile('# User Profile\n\n');
}
