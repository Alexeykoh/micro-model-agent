import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, version as osVersion, hostname } from 'node:os';
import { loadAllMemoryDetailed } from './memory.js';

const USER_DIR = join(homedir(), '.mma', 'user');
const PROFILE_FILE = join(USER_DIR, 'profile.md');
const COUNTER_FILE = join(USER_DIR, '.counter');

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

export function appendToSection(section: string, content: string): void {
  let profile = getProfile();

  const sectionHeader = `## ${section}`;
  const newEntry = `${content}\n`;

  if (profile.includes(sectionHeader)) {
    const idx = profile.indexOf(sectionHeader);
    const sectionEnd = profile.indexOf('\n## ', idx + 1);
    if (sectionEnd === -1) {
      profile += `\n${newEntry}`;
    } else {
      const before = profile.slice(0, sectionEnd);
      const after = profile.slice(sectionEnd);
      profile = before + `\n${newEntry}` + after;
    }
  } else {
    profile += `\n${sectionHeader}\n${newEntry}`;
  }

  writeProfile(profile);
}

export function appendNote(note: string, section: Section = 'Notes'): void {
  appendToSection(section, `- ${note}`);
}

export function addBulletSection(section: Section, items: string[]): void {
  const content = items.map(i => `- ${i}`).join('\n');
  appendToSection(section, content);
}

export function collectOS(): void {
  let existingProfile = '';
  try {
    existingProfile = readFileSync(PROFILE_FILE, 'utf-8');
  } catch {}
  if (existingProfile.includes('## OS')) return;

  let osVer = platform();
  try {
    osVer += ` (${osVersion()})`;
  } catch {}

  const content = [
    `- Platform: ${platform()}`,
    `- Version: ${osVer}`,
    `- Hostname: ${hostname()}`,
    `- Node.js: ${process.version}`,
  ].join('\n');

  appendToSection('OS', content);
}

export function collectTechStack(): void {
  let existingProfile = '';
  try {
    existingProfile = readFileSync(PROFILE_FILE, 'utf-8');
  } catch {}

  const pkgPath = join(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) return;

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }

  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
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
    Other: [],
  };

  const detected: string[] = [];
  for (const dep of depNames) {
    let categorized = false;
    for (const [category, keywords] of Object.entries(techCategories)) {
      if (keywords.some(k => dep.toLowerCase().includes(k))) {
        detected.push(`${dep} (${category})`);
        categorized = true;
        break;
      }
    }
    if (!categorized && !dep.startsWith('@types/') && !dep.startsWith('typescript')) {
      detected.push(dep);
    }
  }

  if (detected.length === 0) return;

  if (existingProfile.includes('## Tech Stack')) {
    const currentLines = detected.map(d => `- ${d}`).join('\n');
    const existingContent = existingProfile.split('## Tech Stack')[1]?.split('## ')[0] || '';
    if (existingContent.includes(currentLines)) return;
  }

  const content = detected.map(d => `- ${d}`).join('\n');
  appendToSection('Tech Stack', content);
}

export function collectCodingStyle(filePath: string, content: string): void {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  if (!['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return;

  const observations: string[] = [];

  const lines = content.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  if (nonEmptyLines.length < 3) return;

  const indentLines = nonEmptyLines.filter(l => l[0] === ' ' || l[0] === '\t');
  if (indentLines.length > 0) {
    const firstIndent = indentLines[0];
    if (firstIndent[0] === '\t') {
      observations.push('Индентация: табуляция');
    } else {
      const spaceCount = firstIndent.search(/\S/);
      observations.push(`Индентация: ${spaceCount} пробела`);
    }
  }

  const singleQuoteLines = lines.filter(l => l.includes("'") && !l.includes('"'));
  const doubleQuoteLines = lines.filter(l => l.includes('"') && !l.includes("'"));
  if (singleQuoteLines.length > doubleQuoteLines.length * 1.5) {
    observations.push('Кавычки: одинарные');
  } else if (doubleQuoteLines.length > singleQuoteLines.length * 1.5) {
    observations.push('Кавычки: двойные');
  }

  const semicolonLines = lines.filter(l => l.trim().endsWith(';') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'));
  const noSemiLines = lines.filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.endsWith(';') && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('import') && !t.startsWith('export') && !t.startsWith('{') && !t.startsWith('}') && !t.startsWith('(') && !t.endsWith('{') && !t.endsWith('}') && !t.endsWith(',');
  });
  if (semicolonLines.length > noSemiLines.length * 2) {
    observations.push('Точки с запятой: да');
  } else if (noSemiLines.length > semicolonLines.length * 2) {
    observations.push('Точки с запятой: нет');
  }

  if (observations.length === 0) return;

  let existingProfile = '';
  try {
    existingProfile = readFileSync(PROFILE_FILE, 'utf-8');
  } catch {}

  const observationsJoined = observations.join('; ');
  if (existingProfile.includes(observationsJoined)) return;

  appendToSection('Coding Style', `- ${observations.join('\n- ')}`);
}

export function collectSessionStart(): void {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('ru-RU');

  appendToSection('Session Patterns', `- Сессия начата: ${dateStr} ${timeStr}`);

  let counter = 1;
  try {
    if (existsSync(COUNTER_FILE)) {
      counter = parseInt(readFileSync(COUNTER_FILE, 'utf-8').trim(), 10) + 1;
    }
  } catch {}
  try {
    writeFileSync(COUNTER_FILE, String(counter), 'utf-8');
  } catch {}

  const existing = getProfile();
  if (!existing.includes('Всего сессий:')) {
    appendToSection('Session Patterns', `- Всего сессий: ${counter}`);
  }
}

export function loadProfileSummary(): string {
  const profile = loadProfile();
  if (!profile || profile.includes('_No profile data yet._')) return '';

  const lines = profile.split('\n').filter(l => l.startsWith('- ') || l.startsWith('## '));
  if (lines.length === 0) return '';

  const sections: string[] = [];
  let currentSection = '';
  let items: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentSection && items.length > 0) {
        sections.push(`  ${currentSection}: ${items.join(', ')}`);
      }
      currentSection = line.replace('## ', '').trim();
      items = [];
    } else if (line.startsWith('- ') && currentSection) {
      const val = line.replace('- ', '').trim();
      if (currentSection === 'Notes') continue;
      items.push(val);
    }
  }
  if (currentSection && items.length > 0) {
    sections.push(`  ${currentSection}: ${items.join(', ')}`);
  }

  if (sections.length === 0) return '';
  return `\n## User Profile\n${sections.join('\n')}\n`;
}

export function sessionEnded(): void {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('ru-RU');
  appendToSection('Session Patterns', `- Сессия завершена: ${timeStr}`);
}

export function initDefaultProfile(): void {
  ensureUserDir();
  if (existsSync(PROFILE_FILE)) return;

  const defaults = `# User Profile

Профиль пользователя. Заполняется автоматически и агентом.
Агент может добавлять заметки через инструмент user_profile.

`;
  writeProfile(defaults);
}
