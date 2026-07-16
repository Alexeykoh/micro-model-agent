import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const SKILLS_DIR = join(homedir(), '.mma', 'skills');
const SKILLS_GLOBAL_DIR = join(homedir(), '.claude', 'skills');

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
  const candidates = [
    join(cwd, '.claude', 'skills', name, 'SKILL.md'),
    join(cwd, '.agents', 'skills', name, 'SKILL.md'),
    join(cwd, '.opencode', 'skills', name, 'SKILL.md'),
    join(SKILLS_DIR, name, 'SKILL.md'),
    join(SKILLS_GLOBAL_DIR, name, 'SKILL.md'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8').trim();
        if (content) {
          return { name, path, content, tokens: Math.ceil(content.length / 4) };
        }
      } catch { /* skip */ }
    }
  }
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

export function listInstalledSkills(): string[] {
  const skills: string[] = [];

  for (const dir of [SKILLS_DIR, SKILLS_GLOBAL_DIR]) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = join(dir, entry.name, 'SKILL.md');
          if (existsSync(skillPath) && !skills.includes(entry.name)) {
            skills.push(entry.name);
          }
        }
      }
    } catch { /* skip */ }
  }

  return skills.sort();
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

export function formatSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(s => `### ${s.name}\n${s.content}`);
  return `## Loaded Skills\n\n${parts.join('\n\n')}`;
}
