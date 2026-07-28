import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { logDebug } from '../logger.js';

/**
 * Загрузчик скилов агента.
 *
 * Скилы загружаются из нескольких источников (в порядке приоритета):
 * 1. Проектные скилы (.agents/skills/, .claude/skills/)
 * 2. Глобальные скилы (~/.claude/skills/, ~/.agents/skills/, ~/.mimocode/skills/)
 * 3. Встроенные скилы (dist/skills/builtin/)
 *
 * Каждый скил — это markdown-файл SKILL.md с инструкциями.
 * Скилы добавляются в system prompt агента.
 *
 * @module skills/loader
 */

const SKILLS_DIR = join(homedir(), '.mma', 'skills');

// Built-in skills bundled with MMA (shipped in dist/skills/builtin/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUILTIN_SKILLS_DIR = join(__dirname, 'builtin');

// Global skill directories searched in order (project-local dirs checked first in loadSkill)
const SKILLS_GLOBAL_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.agents', 'skills'),
  join(homedir(), '.mimocode', 'skills'),
  join(homedir(), '.opencode', 'skills'),
];

export interface Skill {
  name: string;
  path: string;
  content: string;
  tokens: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadAgentsMd(cwd: string): string | null {
  const candidates = [
    join(cwd, 'AGENTS.md'),
    join(cwd, '.agents', 'AGENTS.md'),
    join(cwd, '.claude', 'AGENTS.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8').trim();
        if (content) return content;
      } catch { /* skip */ }
    }
  }
  return null;
}

export function loadSkill(name: string, cwd: string): Skill | null {
  const start = performance.now();
  const candidates = [
    // Built-in skills (bundled with MMA, highest priority)
    join(BUILTIN_SKILLS_DIR, name, 'SKILL.md'),
    // Project-local directories
    join(cwd, '.claude', 'skills', name, 'SKILL.md'),
    join(cwd, '.agents', 'skills', name, 'SKILL.md'),
    join(cwd, '.opencode', 'skills', name, 'SKILL.md'),
    // User-local MMA skills
    join(SKILLS_DIR, name, 'SKILL.md'),
    // Global skill directories (shared across harnesses)
    ...SKILLS_GLOBAL_DIRS.map(dir => join(dir, name, 'SKILL.md')),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8').trim();
        if (content) {
          const elapsed = (performance.now() - start).toFixed(1);
          logDebug('SKILLS', `loaded skill "${name}" from ${path} in ${elapsed}ms`);
          return { name, path, content, tokens: Math.ceil(content.length / 4) };
        }
      } catch { /* skip */ }
    }
  }
  logDebug('SKILLS', `skill "${name}" not found`);
  return null;
}

export function loadSkillsFromRefs(text: string, cwd: string): Skill[] {
  const skills: Skill[] = [];
  const refs = text.matchAll(/@(\w[\w-]*)/g);

  for (const match of refs) {
    const name = match[1];
    const skill = loadSkill(name, cwd);
    if (skill) skills.push(skill);
  }

  return skills;
}

function scanDirSkills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
      .map(e => e.name);
  } catch {
    return [];
  }
}

export interface SkillsBySource {
  builtin: string[];
  project: string[];
  global: string[];
}

export function listSkillsBySource(cwd: string): SkillsBySource {
  const builtin = scanDirSkills(BUILTIN_SKILLS_DIR);
  const builtinSet = new Set(builtin);

  const project = [
    ...scanDirSkills(join(cwd, '.claude', 'skills')),
    ...scanDirSkills(join(cwd, '.agents', 'skills')),
    ...scanDirSkills(join(cwd, '.opencode', 'skills')),
  ].filter(s => !builtinSet.has(s));
  const projectSet = new Set(project);

  const global = [
    ...scanDirSkills(SKILLS_DIR),
    ...SKILLS_GLOBAL_DIRS.flatMap(d => scanDirSkills(d)),
  ].filter(s => !builtinSet.has(s) && !projectSet.has(s));

  return { builtin, project, global };
}

export function listInstalledSkills(cwd?: string): string[] {
  const bySource = listSkillsBySource(cwd ?? process.cwd());
  const all = [...new Set([...bySource.builtin, ...bySource.project, ...bySource.global])];
  return all.sort();
}

export function installSkillFromUrl(name: string, url: string): boolean {
  ensureDir(SKILLS_DIR);
  const skillDir = join(SKILLS_DIR, name);

  try {
    // Simple HTTP fetch using built-in fetch (Node 18+)
    const response = fetchSync(url);
    if (!response) return false;

    ensureDir(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), response, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function fetchSync(url: string): string | null {
  try {
    const { execSync } = require('child_process');
    const result = execSync(`curl -sL "${url}"`, { encoding: 'utf-8', timeout: 10000 });
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Ограничивает набор скилов по токен-бюджету.
 * Сортирует по размеру (меньшие优先), обрезает если превышен бюджет.
 * Возвращает обрезанный список + список отброшенных.
 */
export function enforceSkillBudget(
  skills: Skill[],
  tokenBudget: number,
): { allowed: Skill[]; dropped: string[] } {
  const allowed: Skill[] = [];
  let usedTokens = 0;
  const dropped: string[] = [];

  // Сортируем по размеру — preferring smaller, more focused skills
  const sorted = [...skills].sort((a, b) => a.tokens - b.tokens);

  for (const skill of sorted) {
    if (usedTokens + skill.tokens <= tokenBudget) {
      allowed.push(skill);
      usedTokens += skill.tokens;
    } else {
      dropped.push(skill.name);
    }
  }

  return { allowed, dropped };
}

// ─── Keyword-based skill preloading (pre-load по ключевым словам) ──

let skillIndexCache: Map<string, string[]> | null = null;

/**
 * Извлекает ключевые слова из скилла: сегменты имени + слова из описания (frontmatter).
 */
/**
 * Разбивает текст на слова через Intl.Segmenter — корректно для всех языков.
 */
function splitWords(text: string): string[] {
  const segmenter = new Intl.Segmenter('any', { granularity: 'word' });
  const words: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text.toLowerCase())) {
    if (isWordLike && segment.length > 1) {
      words.push(segment);
    }
  }
  return words;
}

function getSkillKeywords(name: string, cwd: string): string[] {
  const keywords = new Set<string>();

  for (const seg of name.split('-')) {
    if (seg.length > 1) keywords.add(seg.toLowerCase());
  }

  const skill = loadSkill(name, cwd);
  if (skill) {
    const fmMatch = skill.content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
      if (descLine) {
        const desc = descLine.replace(/^description:\s*"?([^"]*)"?\s*$/, '$1').trim();
        for (const w of splitWords(desc)) keywords.add(w);
      }
    }
  }

  return [...keywords];
}

function buildSkillIndex(cwd: string): Map<string, string[]> {
  if (skillIndexCache) return skillIndexCache;

  const names = listInstalledSkills(cwd);
  const index = new Map<string, string[]>();

  logDebug('SKILLS', `building keyword index for ${names.length} skills...`);
  for (const name of names) {
    index.set(name, getSkillKeywords(name, cwd));
  }
  logDebug('SKILLS', `keyword index built`);

  skillIndexCache = index;
  return index;
}

/**
 * Извлекает поисковые термы из текста — просто слова, никакой лингвистики.
 * Матчинг работает по совпадению слов в одном языке.
 * Поддерживает все языки через Intl.Segmenter.
 */
function extractSearchTerms(text: string): Set<string> {
  return new Set(splitWords(text));
}

/**
 * Проверяет, просит ли пользователь явно "используй скилл".
 */
export function isSkillRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(skill|скилл|скил|навык|плаг(ин|ина?))\b/.test(lower);
}

/**
 * Pre-загружает скиллы на основе совпадения ключевых слов в запросе.
 *
 * Решает проблему: пользователь просит "используй скилл для дизайна",
 * но модель не догадывается упомянуть @ui-ux-pro-max в ответе.
 *
 * Алгоритм:
 * 1. Строит индекс ключевых слов (имя + описание) для всех скиллов (кэш)
 * 2. Извлекает термы из запроса (с русско-английским переводом)
 * 3. Ищет пересечение: совпадение в имени = +2 балла, в описании = +1
 * 4. Возвращает топ-3 скилла с наибольшим скором
 */
const STOP_WORDS = new Set([
  'en', 'by', 'it', 'is', 'to', 'of', 'in', 'at', 'on', 'be', 'he', 'as',
  'an', 'or', 'we', 'us', 'my', 'do', 'no', 'go', 'up', 'if', 'am', 'me',
  'so', 'by', 'tv', 'ok', 'hi', 'ex', 'vs', 'et', 'al', 'de', 'la', 'le',
]);

export function preloadSkillsByKeywords(text: string, cwd: string): Skill[] {
  const index = buildSkillIndex(cwd);
  const searchTerms = extractSearchTerms(text);

  logDebug('SKILLS', `keyword preload: "${text.slice(0, 60)}" (${searchTerms.size} terms)`);

  if (searchTerms.size === 0) return [];

  const matched: { name: string; score: number }[] = [];

  for (const [name, keywords] of index) {
    let score = 0;

    for (const term of searchTerms) {
      if (term.length >= 4) {
        if (name.includes(term)) {
          score += 2;
        }
      }
      if (!STOP_WORDS.has(term) && keywords.includes(term)) {
        score += 1;
      }
    }

    if (score > 0) {
      matched.push({ name, score });
    }
  }

  matched.sort((a, b) => b.score - a.score);
  const top = matched.slice(0, 3);

  if (top.length > 0) {
    logDebug('SKILLS', `keyword preload matched: ${top.map(m => `${m.name}(${m.score})`).join(', ')}`);
  }

  return top
    .map(m => loadSkill(m.name, cwd))
    .filter((s): s is Skill => s !== null);
}

export function formatSkillsBlock(skills: Skill[], maxContentLength?: number): string {
  if (skills.length === 0) return '';
  const parts = skills.map(s => {
    const content = maxContentLength && s.content.length > maxContentLength
      ? s.content.slice(0, maxContentLength) + '\n\n[...truncated, full skill has ' + s.tokens + ' tokens]'
      : s.content;
    return `### ${s.name}\n${content}`;
  });
  return `## Loaded Skills\n\n${parts.join('\n\n')}`;
}
