import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { stripAutoSections, getGitInfo, getSlashCommands } from '../src/repl/commands.js';
import type { OutputRenderer, StatusInfo } from '../src/ui/renderer.js';

function mockRenderer(): OutputRenderer {
  return {
    write() {},
    writeLine() {},
    writeNewline() {},
    writeInfo(_t: string) {},
    writeSuccess(_t: string) {},
    writeWarning(_t: string) {},
    writeError(_t: string) {},
    writeDim(_t: string) {},
    writeBracketTag() {},
    writeHeading() {},
    writeToolHeader() {},
    writeToolPreview() {},
    writeToolResult() {},
    writeMarkdownChunk() {},
    commitMarkdown() {},
    writeSpinner() {},
    clearSpinner() {},
    updateContextUsage() {},
    updateStatus(_i: StatusInfo) {},
    clear() {},
    async prompt() { return ''; },
    writeFileOutput() {},
    start() { return Promise.resolve(); },
    destroy() {},
  };
}

// ── stripAutoSections ──────────────────────────────────────

describe('stripAutoSections', () => {
  it('removes all auto-generated sections', () => {
    const input = `# Project

## Description
desc

## Git
origin

## Tech Stack
TS

## Key Dependencies
lodash

## Commands
build

## Conventions
convention

## Project Structure
src/

## Custom Section
kept
`;
    const result = stripAutoSections(input);
    expect(result).not.toContain('## Description');
    expect(result).not.toContain('## Git');
    expect(result).not.toContain('## Tech Stack');
    expect(result).not.toContain('## Key Dependencies');
    expect(result).not.toContain('## Commands');
    expect(result).not.toContain('## Conventions');
    expect(result).not.toContain('## Project Structure');
    expect(result).toContain('## Custom Section');
    expect(result).toContain('kept');
    expect(result).toContain('# Project');
  });

  it('preserves content before first auto section', () => {
    const input = `# Project

Some intro text.

## Tech Stack
TS
`;
    const result = stripAutoSections(input);
    expect(result).toContain('# Project');
    expect(result).toContain('Some intro text.');
    expect(result).not.toContain('## Tech Stack');
    expect(result).not.toContain('TS');
  });

  it('returns empty string when only auto sections exist', () => {
    const input = `## Description
desc
## Commands
build
`;
    const result = stripAutoSections(input);
    expect(result).toBe('');
  });

  it('preserves multiple custom sections in order', () => {
    const input = `## Custom A
a
## Description
desc
## Custom B
b
## Tech Stack
TS
## Custom C
c
`;
    const result = stripAutoSections(input);
    expect(result).toContain('## Custom A');
    expect(result).toContain('a');
    expect(result).toContain('## Custom B');
    expect(result).toContain('b');
    expect(result).toContain('## Custom C');
    expect(result).toContain('c');
    expect(result).not.toContain('## Description');
    expect(result).not.toContain('## Tech Stack');
  });

  it('handles empty input', () => {
    expect(stripAutoSections('')).toBe('');
  });

  it('handles input with no sections (no ## headers)', () => {
    const input = `Just a plain text
without any headers`;
    const result = stripAutoSections(input);
    expect(result).toBe(input.trim());
  });
});

// ── getGitInfo ──────────────────────────────────────────────

describe('getGitInfo', () => {
  it('returns git info when in a git repository', () => {
    const info = getGitInfo();
    expect(info).not.toBeNull();
    if (info) {
      expect(typeof info.branch).toBe('string');
      expect(info.branch.length).toBeGreaterThan(0);
      expect(typeof info.lastCommit).toBe('string');
      expect(info.lastCommit.length).toBeGreaterThan(0);
    }
  });
});

// ── cmdClear /new ──────────────────────────────────────────

describe('cmdClear', () => {
  it('does not clear history (visual only)', async () => {
    const handler = getSlashCommands().find(c => c.name === 'clear')!.handler;
    const history: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'resp1' },
    ];
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history,
      conversationHistory: history,
      modelLabel: 'test',
    });

    expect(history.length).toBe(2);
  });

  it('calls renderer.clear()', async () => {
    const handler = getSlashCommands().find(c => c.name === 'clear')!.handler;
    let cleared = false;
    const renderer = mockRenderer();
    renderer.clear = () => { cleared = true; };

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    expect(cleared).toBe(true);
  });

  it('does not show any message (silent clear)', async () => {
    const handler = getSlashCommands().find(c => c.name === 'clear')!.handler;
    let msg = '';
    const renderer = mockRenderer();
    renderer.writeInfo = (t: string) => { msg = t; };

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    expect(msg).toBe('');
  });
});

describe('cmdNew', () => {
  it('clears history array', async () => {
    const handler = getSlashCommands().find(c => c.name === 'new')!.handler;
    const history: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'resp1' },
    ];
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history,
      conversationHistory: history,
      modelLabel: 'test',
    });

    expect(history.length).toBe(0);
  });

  it('shows info message after new', async () => {
    const handler = getSlashCommands().find(c => c.name === 'new')!.handler;
    let msg = '';
    const renderer = mockRenderer();
    renderer.writeInfo = (t: string) => { msg = t; };

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    expect(msg).toContain('Context cleared');
  });

  it('calls renderer.clear()', async () => {
    const handler = getSlashCommands().find(c => c.name === 'new')!.handler;
    let cleared = false;
    const renderer = mockRenderer();
    renderer.clear = () => { cleared = true; };

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [{ role: 'user', content: 'msg' }],
      conversationHistory: [{ role: 'user', content: 'msg' }],
      modelLabel: 'test',
    });

    expect(cleared).toBe(true);
  });
});

// ── cmdResume (basic) ───────────────────────────────────────

describe('cmdResume', () => {
  it('shows usage when no args provided', async () => {
    const handler = getSlashCommands().find(c => c.name === 'resume')!.handler;
    const msgs: string[] = [];
    const renderer = mockRenderer();
    renderer.writeInfo = (t: string) => { msgs.push(t); };

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    expect(msgs.some(m => m.includes('Usage'))).toBe(true);
    expect(msgs.some(m => m.includes('/sessions'))).toBe(true);
  });

  it('shows error for non-existent session', async () => {
    const handler = getSlashCommands().find(c => c.name === 'resume')!.handler;
    const errors: string[] = [];
    const renderer = mockRenderer();
    renderer.writeError = (t: string) => { errors.push(t); };

    await handler('nonexistent-session-12345', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    expect(errors.some(m => m.includes('not found'))).toBe(true);
  });
});

// ── cmdInit ─────────────────────────────────────────────────

describe('cmdInit', () => {
  let tmpDir: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mma-init-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates AGENTS.md with project name when no package.json', async () => {
    const handler = getSlashCommands().find(c => c.name === 'init')!.handler;
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    const agentsPath = join(tmpDir, 'AGENTS.md');
    expect(existsSync(agentsPath)).toBe(true);
    const content = readFileSync(agentsPath, 'utf-8');
    expect(content).toContain(basename(tmpDir));
  });

  it('reads package.json and includes description', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      description: 'A test project',
      scripts: { build: 'tsc', test: 'vitest' },
      dependencies: { express: '^4.0' },
      devDependencies: { typescript: '^5.0' },
    }));

    const handler = getSlashCommands().find(c => c.name === 'init')!.handler;
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    const content = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('A test project');
    expect(content).toContain('express');
    expect(content).toContain('typescript');
    expect(content).toContain('npm run build');
    expect(content).toContain('npm test');
  });

  it('detects config files for tech stack', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: {},
    }));
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}');
    writeFileSync(join(tmpDir, 'vite.config.ts'), '');

    const handler = getSlashCommands().find(c => c.name === 'init')!.handler;
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    const content = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('TypeScript');
    expect(content).toContain('Vite');
  });

  it('preserves custom sections from existing AGENTS.md', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: {},
    }));

    // Create existing AGENTS.md with a custom section
    writeFileSync(join(tmpDir, 'AGENTS.md'), `# Old Project

## Description
old desc

## My Custom Section
This is custom content

## Tech Stack
old stack
`);

    const handler = getSlashCommands().find(c => c.name === 'init')!.handler;
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    const content = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf-8');
    // Custom section preserved
    expect(content).toContain('## My Custom Section');
    expect(content).toContain('This is custom content');
    // Auto sections replaced with fresh data
    expect(content).not.toContain('old desc');
    expect(content).not.toContain('old stack');
  });

  it('detects project structure (files and dirs)', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: {},
    }));
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'README.md'), '# readme');
    writeFileSync(join(tmpDir, 'src', 'index.ts'), '');

    const handler = getSlashCommands().find(c => c.name === 'init')!.handler;
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    const content = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('src/');
    expect(content).toContain('README.md');
  });

  it('detects language counts by extension', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: {},
    }));
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src', 'index.ts'), 'const x = 1;');
    writeFileSync(join(tmpDir, 'src', 'style.css'), 'body {}');
    writeFileSync(join(tmpDir, 'index.html'), '<html></html>');

    const handler = getSlashCommands().find(c => c.name === 'init')!.handler;
    const renderer = mockRenderer();

    await handler('', {
      renderer,
      provider: {} as any,
      registry: {} as any,
      history: [],
      conversationHistory: [],
      modelLabel: 'test',
    });

    const content = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('**TS**');
    expect(content).toContain('**CSS**');
    expect(content).toContain('**HTML**');
  });
});

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || '';
}
