import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildCodeIndex, formatCodeIndex, getCodeIndexTokenEstimate } from '../src/indexer/code-index.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), '.mma-test-ast');

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true });

  writeFileSync(join(TEST_DIR, 'src/utils.ts'), `
export function hello(name: string): string {
  return \`Hello \${name}\`;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
}

export interface Config {
  port: number;
  host: string;
}

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}

export const MAX_RETRIES = 3;
`);

  writeFileSync(join(TEST_DIR, 'src/api.ts'), `
import { Calculator } from './utils';
import { hello } from './utils';

export async function fetchData(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

export type ApiResponse = {
  data: any[];
  status: number;
};
`);

  writeFileSync(join(TEST_DIR, 'test.py'), `
def greet(name):
    return f"Hello {name}"

class Person:
    def __init__(self, name):
        self.name = name
`);
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('CodeIndex — AST symbol extraction', () => {
  it('builds index from project directory', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index).toBeDefined();
    expect(index.symbols).toBeDefined();
    expect(index.fileHashes).toBeDefined();
  });

  it('detects TypeScript functions', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['hello']).toBeDefined();
    expect(index.symbols['hello'].type).toBe('function');
    expect(index.symbols['hello'].file).toContain('utils.ts');
  });

  it('detects TypeScript classes', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['Calculator']).toBeDefined();
    expect(index.symbols['Calculator'].type).toBe('class');
  });

  it('detects TypeScript interfaces', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['Config']).toBeDefined();
    expect(index.symbols['Config'].type).toBe('type');
  });

  it('detects TypeScript enums', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['Status']).toBeDefined();
    expect(index.symbols['Status'].type).toBe('enum');
  });

  it('detects TypeScript const', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['MAX_RETRIES']).toBeDefined();
    expect(index.symbols['MAX_RETRIES'].type).toBe('const');
  });

  it('detects async functions', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['fetchData']).toBeDefined();
    expect(index.symbols['fetchData'].type).toBe('function');
  });

  it('detects Python functions', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['greet']).toBeDefined();
    expect(index.symbols['greet'].file).toContain('test.py');
  });

  it('detects Python classes', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['Person']).toBeDefined();
  });

  it('records file hashes', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(Object.keys(index.fileHashes).length).toBeGreaterThan(0);
    for (const hash of Object.values(index.fileHashes)) {
      expect(parseInt(hash)).toBeGreaterThan(0);
    }
  });

  it('detects primary language', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.language).toBe('ts');
  });

  it('records line numbers', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['hello'].line).toBeGreaterThan(0);
  });

  it('skips node_modules and .git', () => {
    mkdirSync(join(TEST_DIR, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'node_modules', 'pkg', 'index.ts'), 'export const x = 1;');
    mkdirSync(join(TEST_DIR, '.git'), { recursive: true });
    writeFileSync(join(TEST_DIR, '.git', 'config'), 'noop');

    const index = buildCodeIndex(TEST_DIR);
    const allFiles = Object.keys(index.symbols);
    const hasNodeModule = allFiles.some(f => f.includes('node_modules'));
    expect(hasNodeModule).toBe(false);
  });

  it('formats index for display', () => {
    const index = buildCodeIndex(TEST_DIR);
    const formatted = formatCodeIndex(index);
    expect(formatted).toContain('CODE INDEX');
    expect(formatted).toContain('hello');
    expect(formatted).toContain('Calculator');
  });

  it('estimates token count', () => {
    const index = buildCodeIndex(TEST_DIR);
    const tokens = getCodeIndexTokenEstimate(index);
    expect(tokens).toBeGreaterThan(0);
  });

  it('tracks type signatures', () => {
    const index = buildCodeIndex(TEST_DIR);
    expect(index.symbols['hello'].sig).toContain('hello');
  });
});
