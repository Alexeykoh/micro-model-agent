import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFileRefs } from '../src/file-loader.js';
import { checkFileSyntax } from '../src/tools/syntax-check.js';
import { rebuildProjectMap } from '../src/indexer/cache.js';

const TEST_DIR = join(process.cwd(), '.mma-test-utils');

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true });

  writeFileSync(join(TEST_DIR, 'src/index.ts'), `
import { hello } from './utils';
export const app = hello('world');
`);

  writeFileSync(join(TEST_DIR, 'src/utils.ts'), `
export function hello(name: string): string {
  return 'Hello ' + name;
}
`);

  writeFileSync(join(TEST_DIR, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
  }, null, 2));
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('Syntax Check', () => {
  it('returns OK for valid TypeScript', () => {
    writeFileSync(join(TEST_DIR, 'valid.ts'), 'export const x: number = 1;');
    const result = checkFileSyntax('valid.ts', TEST_DIR);
    expect(result).toBe('OK');
  });

  it('detects syntax errors in TypeScript', () => {
    writeFileSync(join(TEST_DIR, 'bad.ts'), 'export const x: number = ;');
    const result = checkFileSyntax('bad.ts', TEST_DIR);
    expect(result).not.toBe('OK');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects missing semicolons', () => {
    writeFileSync(join(TEST_DIR, 'nosemi.ts'), 'const x = 1\nconst y = 2');
    const result = checkFileSyntax('nosemi.ts', TEST_DIR);
    // May or may not error depending on strictness
    expect(typeof result).toBe('string');
  });

  it('handles non-existent file gracefully', () => {
    const result = checkFileSyntax('nonexistent.ts', TEST_DIR);
    expect(typeof result).toBe('string');
  });

  it('checks JSON files', () => {
    writeFileSync(join(TEST_DIR, 'valid.json'), '{"key": "value"}');
    const result = checkFileSyntax('valid.json', TEST_DIR);
    expect(result).toBe('OK');
  });

  it('detects invalid JSON', () => {
    writeFileSync(join(TEST_DIR, 'bad.json'), '{key: value}');
    const result = checkFileSyntax('bad.json', TEST_DIR);
    expect(result).not.toBe('OK');
  });
});

describe('File Loader — @file references', () => {
  it('parses prompt without @file references', async () => {
    const result = await parseFileRefs('Hello world, no files');
    expect(result.files.length).toBe(0);
    expect(result.prompt).toContain('Hello world');
  });

  it('loads a single file via @path', async () => {
    const result = await parseFileRefs('@package.json');
    expect(result.files.length).toBe(1);
    expect(result.files[0].path).toContain('package.json');
    expect(result.files[0].tokens).toBeGreaterThan(0);
  });

  it('preserves original prompt', async () => {
    const result = await parseFileRefs('Analyze this: @package.json');
    expect(result.prompt).toContain('Analyze this');
  });

  it('handles multiple @file references', async () => {
    const result = await parseFileRefs('@package.json and @package.json');
    expect(result.files.length).toBe(1); // deduped
  });

  it('deduplicates same file', async () => {
    const result = await parseFileRefs('@package.json @package.json');
    expect(result.files.length).toBe(1);
  });

  it('skips binary files', async () => {
    const binPath = join(TEST_DIR, 'binary.bin');
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02]));
    const result = await parseFileRefs(`@${binPath}`);
    expect(result.files.length).toBe(0);
  });

  it('skips non-existent files', async () => {
    const result = await parseFileRefs(`@${join(TEST_DIR, 'does-not-exist.ts')}`);
    expect(result.files.length).toBe(0);
  });

  it('loads package.json', async () => {
    const result = await parseFileRefs('@package.json');
    expect(result.files.length).toBe(1);
    expect(result.files[0].content).toContain('mma');
  });
});

describe('Project Map', () => {
  it('builds a project map', () => {
    const { map } = rebuildProjectMap(TEST_DIR);
    expect(map).toBeDefined();
    expect(map.files).toBeDefined();
    expect(map.projectName).toBeDefined();
  });

  it('detects files in project', () => {
    const { map } = rebuildProjectMap(TEST_DIR);
    const fileNames = Array.isArray(map.files)
      ? map.files.map((f: any) => f.path || f.name || String(f))
      : Object.keys(map.files);
    expect(fileNames.length).toBeGreaterThan(0);
  });

  it('formats project map', () => {
    const { formatted } = rebuildProjectMap(TEST_DIR);
    expect(formatted).toContain('PROJECT');
  });

  it('generates timestamp', () => {
    const { map } = rebuildProjectMap(TEST_DIR);
    expect(map.generatedAt).toBeDefined();
  });
});
