import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleReadFile } from '../src/tools/fs/read-file.js';
import { handleWriteFile } from '../src/tools/fs/write-file.js';
import { handleEditFile } from '../src/tools/fs/edit-file.js';
import { handleListDir } from '../src/tools/fs/list-dir.js';
import { handleCreateDir } from '../src/tools/fs/create-dir.js';
import { handleDeleteFile } from '../src/tools/fs/delete-file.js';
import { handleCopyFile } from '../src/tools/fs/copy-file.js';
import { handleMoveFile } from '../src/tools/fs/move-file.js';
import { handleFileInfo } from '../src/tools/fs/file-info.js';
import { handleGlobSearch } from '../src/tools/fs/glob-search.js';
import { handleGrepSearch } from '../src/tools/fs/grep-search.js';
import { handleTree } from '../src/tools/fs/tree.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mma-fs-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function ok(result: { exitCode: number }) {
  expect(result.exitCode).toBe(0);
}

function fail(result: { exitCode: number }) {
  expect(result.exitCode).toBe(1);
}

describe('write_file', () => {
  it('creates a new file', () => {
    const r = handleWriteFile({ path: 'hello.txt', content: 'Hello World' }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'hello.txt'), 'utf-8')).toBe('Hello World');
    expect(r.stdout).toContain('Written');
  });

  it('creates parent directories', () => {
    const r = handleWriteFile({ path: 'src/deep/file.ts', content: 'export {}' }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'src/deep/file.ts'), 'utf-8')).toBe('export {}');
  });

  it('overwrites existing file', () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'old', 'utf-8');
    const r = handleWriteFile({ path: 'file.txt', content: 'new content' }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'file.txt'), 'utf-8')).toBe('new content');
  });

  it('rejects non-string content', () => {
    const r = handleWriteFile({ path: 'file.txt', content: 123 }, tmpDir);
    fail(r);
    expect(r.stderr).toContain('string');
  });

  it('rejects path outside project root', () => {
    const r = handleWriteFile({ path: '../escape.txt', content: 'nope' }, tmpDir);
    fail(r);
    expect(r.stderr).toContain('escapes');
  });
});

describe('read_file', () => {
  it('reads file with line numbers', () => {
    writeFileSync(join(tmpDir, 'lines.txt'), 'alpha\nbeta\ngamma', 'utf-8');
    const r = handleReadFile({ path: 'lines.txt' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('1: alpha');
    expect(r.stdout).toContain('2: beta');
    expect(r.stdout).toContain('3: gamma');
  });

  it('supports offset and limit', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(join(tmpDir, 'many.txt'), content, 'utf-8');
    const r = handleReadFile({ path: 'many.txt', offset: 5, limit: 3 }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('5: line 5');
    expect(r.stdout).toContain('7: line 7');
    expect(r.stdout).not.toContain('8: line 8');
  });

  it('errors on missing file', () => {
    const r = handleReadFile({ path: 'nope.txt' }, tmpDir);
    fail(r);
    expect(r.stderr).toContain('Not found');
  });
});

describe('edit_file', () => {
  it('replaces text', () => {
    writeFileSync(join(tmpDir, 'edit.txt'), 'hello world', 'utf-8');
    const r = handleEditFile({ path: 'edit.txt', old_string: 'world', new_string: 'MMA' }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'edit.txt'), 'utf-8')).toBe('hello MMA');
    expect(r.stdout).toContain('Replaced');
  });

  it('errors when old_string not found', () => {
    writeFileSync(join(tmpDir, 'edit.txt'), 'hello', 'utf-8');
    const r = handleEditFile({ path: 'edit.txt', old_string: 'missing', new_string: 'x' }, tmpDir);
    fail(r);
    expect(r.stderr).toContain('not found');
  });

  it('errors on multiple matches without replace_all', () => {
    writeFileSync(join(tmpDir, 'edit.txt'), 'aaa bbb aaa', 'utf-8');
    const r = handleEditFile({ path: 'edit.txt', old_string: 'aaa', new_string: 'x' }, tmpDir);
    fail(r);
    expect(r.stderr).toContain('multiple times');
  });

  it('replaces all with replace_all', () => {
    writeFileSync(join(tmpDir, 'edit.txt'), 'aaa bbb aaa', 'utf-8');
    const r = handleEditFile({ path: 'edit.txt', old_string: 'aaa', new_string: 'x', replace_all: true }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'edit.txt'), 'utf-8')).toBe('x bbb x');
    expect(r.stdout).toContain('2 occurrence');
  });
});

describe('list_dir', () => {
  it('lists directory contents', () => {
    writeFileSync(join(tmpDir, 'a.txt'), '', 'utf-8');
    mkdirSync(join(tmpDir, 'subdir'));
    const r = handleListDir({ path: '.' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('a.txt');
    expect(r.stdout).toContain('subdir/');
  });

  it('defaults to cwd', () => {
    writeFileSync(join(tmpDir, 'here.txt'), '', 'utf-8');
    const r = handleListDir({}, tmpDir);
    ok(r);
    expect(r.stdout).toContain('here.txt');
  });
});

describe('create_dir', () => {
  it('creates directory', () => {
    const r = handleCreateDir({ path: 'new-dir' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('Created');
  });

  it('creates nested directories', () => {
    const r = handleCreateDir({ path: 'a/b/c' }, tmpDir);
    ok(r);
  });
});

describe('delete_file', () => {
  it('deletes a file', () => {
    writeFileSync(join(tmpDir, 'del.txt'), '', 'utf-8');
    const r = handleDeleteFile({ path: 'del.txt' }, tmpDir);
    ok(r);
  });

  it('fails on directory without recursive', () => {
    mkdirSync(join(tmpDir, 'dir'));
    const r = handleDeleteFile({ path: 'dir' }, tmpDir);
    fail(r);
    expect(r.stderr).toContain('recursive');
  });

  it('deletes directory with recursive', () => {
    mkdirSync(join(tmpDir, 'dir'));
    writeFileSync(join(tmpDir, 'dir/file.txt'), '', 'utf-8');
    const r = handleDeleteFile({ path: 'dir', recursive: true }, tmpDir);
    ok(r);
  });
});

describe('copy_file', () => {
  it('copies a file', () => {
    writeFileSync(join(tmpDir, 'src.txt'), 'content', 'utf-8');
    const r = handleCopyFile({ source: 'src.txt', destination: 'dst.txt' }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'dst.txt'), 'utf-8')).toBe('content');
  });

  it('creates destination directories', () => {
    writeFileSync(join(tmpDir, 'src.txt'), 'x', 'utf-8');
    const r = handleCopyFile({ source: 'src.txt', destination: 'a/b/dst.txt' }, tmpDir);
    ok(r);
  });
});

describe('move_file', () => {
  it('moves a file', () => {
    writeFileSync(join(tmpDir, 'old.txt'), 'data', 'utf-8');
    const r = handleMoveFile({ source: 'old.txt', destination: 'new.txt' }, tmpDir);
    ok(r);
    expect(readFileSync(join(tmpDir, 'new.txt'), 'utf-8')).toBe('data');
  });
});

describe('file_info', () => {
  it('returns metadata', () => {
    writeFileSync(join(tmpDir, 'info.txt'), 'hello', 'utf-8');
    const r = handleFileInfo({ path: 'info.txt' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('file');
    expect(r.stdout).toContain('5 B');
  });
});

describe('glob_search', () => {
  it('finds files by pattern', () => {
    writeFileSync(join(tmpDir, 'a.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'b.js'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'c.py'), '', 'utf-8');
    const r = handleGlobSearch({ pattern: '*.ts' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('a.ts');
    expect(r.stdout).not.toContain('b.js');
  });

  it('supports recursive patterns', () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src/index.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'test.ts'), '', 'utf-8');
    const r = handleGlobSearch({ pattern: '**/*.ts' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('src/index.ts');
    expect(r.stdout).toContain('test.ts');
  });
});

describe('grep_search', () => {
  it('finds content matches', () => {
    writeFileSync(join(tmpDir, 'code.ts'), 'function foo() {}\nconst bar = 1;', 'utf-8');
    const r = handleGrepSearch({ pattern: 'function' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('function foo');
  });

  it('supports include filter', () => {
    writeFileSync(join(tmpDir, 'a.ts'), 'function x() {}', 'utf-8');
    writeFileSync(join(tmpDir, 'b.js'), 'function y() {}', 'utf-8');
    const r = handleGrepSearch({ pattern: 'function', include: '*.ts' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('a.ts');
    expect(r.stdout).not.toContain('b.js');
  });

  it('returns no matches message', () => {
    writeFileSync(join(tmpDir, 'a.txt'), 'hello', 'utf-8');
    const r = handleGrepSearch({ pattern: 'zzz' }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('No matches');
  });
});

describe('tree', () => {
  it('shows directory tree', () => {
    mkdirSync(join(tmpDir, 'src'));
    writeFileSync(join(tmpDir, 'src/index.ts'), '', 'utf-8');
    writeFileSync(join(tmpDir, 'README.md'), '', 'utf-8');
    const r = handleTree({ depth: 2 }, tmpDir);
    ok(r);
    expect(r.stdout).toContain('src/');
    expect(r.stdout).toContain('index.ts');
    expect(r.stdout).toContain('README.md');
  });
});

describe('path security', () => {
  it('rejects path traversal in all tools', () => {
    const malicious = '../../etc/passwd';
    expect(handleReadFile({ path: malicious }, tmpDir).exitCode).toBe(1);
    expect(handleWriteFile({ path: malicious, content: 'x' }, tmpDir).exitCode).toBe(1);
    expect(handleEditFile({ path: malicious, old_string: 'a', new_string: 'b' }, tmpDir).exitCode).toBe(1);
    expect(handleDeleteFile({ path: malicious }, tmpDir).exitCode).toBe(1);
    expect(handleCopyFile({ source: 'x', destination: malicious }, tmpDir).exitCode).toBe(1);
    expect(handleMoveFile({ source: 'x', destination: malicious }, tmpDir).exitCode).toBe(1);
    expect(handleFileInfo({ path: malicious }, tmpDir).exitCode).toBe(1);
  });
});
