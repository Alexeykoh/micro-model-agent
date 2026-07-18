import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  ensureUserDir,
  loadProfile,
  profileExists,
  appendToSection,
  appendNote,
  collectOS,
  collectTechStack,
  collectCodingStyle,
  collectSessionStart,
  sessionEnded,
  loadProfileSummary,
  initDefaultProfile,
} from '../src/agent/user-profile.js';

const USER_DIR = join(homedir(), '.mma', 'user');
const PROFILE_FILE = join(USER_DIR, 'profile.md');

function cleanup() {
  try { rmSync(USER_DIR, { recursive: true, force: true }); } catch {}
}

describe('User Profile', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('creates user directory on ensure', () => {
    ensureUserDir();
    expect(existsSync(USER_DIR)).toBe(true);
  });

  it('initDefaultProfile creates empty profile', () => {
    initDefaultProfile();
    expect(existsSync(PROFILE_FILE)).toBe(true);
    const content = readFileSync(PROFILE_FILE, 'utf-8');
    expect(content).toContain('# User Profile');
  });

  it('initDefaultProfile does not overwrite existing', () => {
    writeFileSync(PROFILE_FILE, '# Custom Profile\n', 'utf-8');
    initDefaultProfile();
    const content = readFileSync(PROFILE_FILE, 'utf-8');
    expect(content).toBe('# Custom Profile\n');
  });

  it('loadProfile reads saved content', () => {
    writeFileSync(PROFILE_FILE, '# User Profile\n\n## Notes\n- test note\n', 'utf-8');
    const content = loadProfile();
    expect(content).toContain('# User Profile');
    expect(content).toContain('test note');
  });

  it('loadProfile returns empty string for missing file', () => {
    cleanup();
    expect(loadProfile()).toBe('');
  });

  it('profileExists returns true/false', () => {
    cleanup();
    expect(profileExists()).toBe(false);
    initDefaultProfile();
    expect(profileExists()).toBe(true);
  });

  it('appendToSection adds to new section', () => {
    cleanup();
    initDefaultProfile();
    appendToSection('Notes', '- my note');
    const content = loadProfile();
    expect(content).toContain('## Notes');
    expect(content).toContain('my note');
  });

  it('appendToSection appends to existing section', () => {
    appendToSection('Notes', '- second note');
    const content = loadProfile();
    const notesSection = content.split('## Notes')[1].split('##')[0];
    expect(notesSection).toContain('my note');
    expect(notesSection).toContain('second note');
    expect(notesSection.indexOf('second note')).toBeGreaterThan(notesSection.indexOf('my note'));
  });

  it('appendNote adds to Notes section by default', () => {
    appendNote('remembered preference');
    const content = loadProfile();
    expect(content).toContain('remembered preference');
  });

  it('collectOS writes OS info once', () => {
    cleanup();
    initDefaultProfile();
    collectOS();
    const content = loadProfile();
    expect(content).toContain('## OS');
    expect(content).toContain('Platform:');
    expect(content).toContain('Node.js:');
  });

  it('collectOS does not duplicate on second call', () => {
    const contentBefore = loadProfile();
    collectOS();
    const contentAfter = loadProfile();
    expect(contentAfter).toBe(contentBefore);
  });

  it('collectCodingStyle detects indentation', () => {
    cleanup();
    initDefaultProfile();
    const code = `function foo() {\n  const x = 1;\n  return x;\n}\n`;
    collectCodingStyle('test.ts', code);
    const content = loadProfile();
    expect(content).toContain('Индентация');
  });

  it('collectCodingStyle detects single quotes', () => {
    const code = `const x = 'hello';\nconst y = 'world';\nconst z = '!';\n`;
    collectCodingStyle('test.ts', code);
    const content = loadProfile();
    expect(content).toContain('одинарные');
  });

  it('collectCodingStyle detects double quotes', () => {
    cleanup();
    initDefaultProfile();
    const code = `const x = "hello";\nconst y = "world";\nconst z = "!";\n`;
    collectCodingStyle('test.ts', code);
    const content = loadProfile();
    expect(content).toContain('двойные');
  });

  it('collectCodingStyle ignores non-code extensions', () => {
    const contentBefore = loadProfile();
    collectCodingStyle('readme.md', 'some text');
    const contentAfter = loadProfile();
    expect(contentAfter).toBe(contentBefore);
  });

  it('collectCodingStyle ignores short files', () => {
    const contentBefore = loadProfile();
    collectCodingStyle('test.ts', 'a\nb');
    const contentAfter = loadProfile();
    expect(contentAfter).toBe(contentBefore);
  });

  it('collectSessionStart records date/time', () => {
    cleanup();
    initDefaultProfile();
    collectSessionStart();
    const content = loadProfile();
    expect(content).toContain('## Session Patterns');
    expect(content).toContain('Сессия начата');
  });

  it('collectSessionStart increments counter', () => {
    const content = loadProfile();
    expect(content).toContain('Всего сессий:');
  });

  it('sessionEnded records end time', () => {
    sessionEnded();
    const content = loadProfile();
    expect(content).toContain('Сессия завершена');
  });

  it('loadProfileSummary returns formatted summary', () => {
    cleanup();
    initDefaultProfile();
    appendToSection('OS', '- Platform: win32\n- Version: Windows');
    appendToSection('Coding Style', '- Индентация: 2 пробела');

    const summary = loadProfileSummary();
    expect(summary).toContain('## User Profile');
    expect(summary).toContain('OS');
    expect(summary).toContain('Coding Style');
    expect(summary).not.toContain('Notes');
  });

  it('loadProfileSummary returns empty for empty profile', () => {
    cleanup();
    const summary = loadProfileSummary();
    expect(summary).toBe('');
  });

  it('collectTechStack detects dependencies', () => {
    cleanup();
    initDefaultProfile();

    const pkgPath = join(process.cwd(), 'package.json');
    const origPkg = existsSync(pkgPath) ? readFileSync(pkgPath, 'utf-8') : null;

    try {
      writeFileSync(pkgPath, JSON.stringify({
        name: 'test',
        dependencies: { react: '^18.0.0', next: '^14.0.0' },
        devDependencies: { vitest: '^1.0.0', eslint: '^8.0.0' },
      }), 'utf-8');

      collectTechStack();
      const content = loadProfile();
      expect(content).toContain('## Tech Stack');
      expect(content).toContain('react');
      expect(content).toContain('vitest');
    } finally {
      if (origPkg) writeFileSync(pkgPath, origPkg, 'utf-8');
    }
  });

  it('collectTechStack does not create duplicate section headers', () => {
    const content = loadProfile();
    const headers = content.match(/## Tech Stack/g);
    expect(headers).toHaveLength(1);
  });
});
