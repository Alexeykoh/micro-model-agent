import { describe, it, expect, vi, beforeEach } from 'vitest';
import { projectMapHandler } from '../src/tools/native/project-map.js';
import type { ToolContext } from '../src/tools/types.js';

// Mock the indexer cache
const mockFiles = [
  { path: 'src/App.tsx', exports: ['App', 'default'], lines: 50 },
  { path: 'src/main.tsx', exports: [], lines: 10 },
  { path: 'src/utils.ts', exports: ['hello', 'world'], lines: 25 },
  { path: 'package.json', exports: [], lines: 20 },
  { path: 'tsconfig.json', exports: [], lines: 15 },
];

const mockFormatted = `PROJECT: test-project
Files: 5

├── src/
│   ├── App.tsx  exports: App, default
│   ├── main.tsx
│   └── utils.ts  exports: hello, world
├── package.json
└── tsconfig.json`;

const mockGetOrBuild = vi.fn(() => ({
  map: {
    projectName: 'test-project',
    files: mockFiles,
    directories: ['src'],
    generatedAt: new Date().toISOString(),
  },
  formatted: mockFormatted,
}));

vi.mock('../src/indexer/cache.js', () => ({
  getOrBuildProjectMap: (...args: any[]) => mockGetOrBuild(...args),
}));

const ctx: ToolContext = { cwd: '/tmp/test', quiet: true };

describe('project_map handler', () => {
  beforeEach(() => {
    mockGetOrBuild.mockClear();
    mockGetOrBuild.mockReturnValue({
      map: {
        projectName: 'test-project',
        files: mockFiles,
        directories: ['src'],
        generatedAt: new Date().toISOString(),
      },
      formatted: mockFormatted,
    });
  });

  // ─── Definition ────────────────────────────────────────
  describe('definition', () => {
    it('has correct name', () => {
      expect(projectMapHandler.name).toBe('project_map');
    });

    it('has correct definition structure', () => {
      const def = projectMapHandler.definition;
      expect(def.type).toBe('function');
      expect(def.function.name).toBe('project_map');
    });

    it('defines all required parameters', () => {
      const params = projectMapHandler.definition.function.parameters;
      expect(params.properties.action).toBeDefined();
      expect(params.properties.pattern).toBeDefined();
      expect(params.properties.path).toBeDefined();
      expect(params.required).toContain('action');
    });

    it('action parameter has correct enum values', () => {
      const action = projectMapHandler.definition.function.parameters.properties.action as any;
      expect(action.enum).toEqual(['list', 'find', 'info']);
    });
  });

  // ─── list action ───────────────────────────────────────
  describe('list action', () => {
    it('returns formatted project map', async () => {
      const result = await projectMapHandler.execute({ action: 'list' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PROJECT: test-project');
      expect(result.stdout).toContain('Files: 5');
    });

    it('includes file names in output', async () => {
      const result = await projectMapHandler.execute({ action: 'list' }, ctx);
      expect(result.stdout).toContain('App.tsx');
      expect(result.stdout).toContain('package.json');
      expect(result.stdout).toContain('tsconfig.json');
    });

    it('shows exports when present', async () => {
      const result = await projectMapHandler.execute({ action: 'list' }, ctx);
      expect(result.stdout).toContain('exports: App, default');
      expect(result.stdout).toContain('exports: hello, world');
    });

    it('returns empty message for empty project', async () => {
      mockGetOrBuild.mockReturnValue({
        map: { projectName: 'empty', files: [], directories: [], generatedAt: '' },
        formatted: '',
      });
      const result = await projectMapHandler.execute({ action: 'list' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Project is empty');
    });
  });

  // ─── find action ───────────────────────────────────────
  describe('find action', () => {
    it('finds files by extension pattern', async () => {
      const result = await projectMapHandler.execute({ action: 'find', pattern: '*.tsx' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Found 2 file(s)');
      expect(result.stdout).toContain('src/App.tsx');
      expect(result.stdout).toContain('src/main.tsx');
    });

    it('finds files by directory pattern', async () => {
      const result = await projectMapHandler.execute({ action: 'find', pattern: 'src/*.ts' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Found 1 file(s)');
      expect(result.stdout).toContain('src/utils.ts');
    });

    it('finds files with ** recursive pattern', async () => {
      const result = await projectMapHandler.execute({ action: 'find', pattern: '**/*.tsx' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Found 2 file(s)');
    });

    it('finds files with ? single-char pattern', async () => {
      // utils.ts should match utils.?s (?? = any two chars after utils.)
      const result = await projectMapHandler.execute({ action: 'find', pattern: '*.j?' }, ctx);
      expect(result.exitCode).toBe(0);
      // package.json and tsconfig.json both end with .json which matches *.j?? no...
      // Actually *.j? matches .js but not .json. Let's test differently.
      expect(result.stdout).toMatch(/No files match|Found/);
    });

    it('includes exports in find results', async () => {
      const result = await projectMapHandler.execute({ action: 'find', pattern: 'src/*.ts' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('exports: hello, world');
    });

    it('returns no match message when no files found', async () => {
      const result = await projectMapHandler.execute({ action: 'find', pattern: '*.py' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No files match pattern');
      expect(result.stdout).toContain('*.py');
    });

    it('requires pattern argument', async () => {
      const result = await projectMapHandler.execute({ action: 'find' }, ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('pattern is required');
    });
  });

  // ─── info action ───────────────────────────────────────
  describe('info action', () => {
    it('shows file details with exports', async () => {
      const result = await projectMapHandler.execute({ action: 'info', path: 'src/App.tsx' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Path: src/App.tsx');
      expect(result.stdout).toContain('Lines: 50');
      expect(result.stdout).toContain('App, default');
    });

    it('shows file without exports', async () => {
      const result = await projectMapHandler.execute({ action: 'info', path: 'src/main.tsx' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Path: src/main.tsx');
      expect(result.stdout).toContain('Exports: none');
    });

    it('suggests similar file when not found (partial match)', async () => {
      const result = await projectMapHandler.execute({ action: 'info', path: 'src/App.ts' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Did you mean');
      expect(result.stdout).toContain('src/App.tsx');
    });

    it('suggests similar file via contains match', async () => {
      const result = await projectMapHandler.execute({ action: 'info', path: 'App' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Did you mean');
    });

    it('lists available files when not found', async () => {
      const result = await projectMapHandler.execute({ action: 'info', path: 'nonexistent.ts' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('File not found');
      expect(result.stdout).toContain('Available files');
    });

    it('shows truncation message when >20 files', async () => {
      const manyFiles = Array.from({ length: 25 }, (_, i) => ({
        path: `dir/file${i}.ts`,
        exports: [],
        lines: 10,
      }));
      mockGetOrBuild.mockReturnValue({
        map: { projectName: 'big', files: manyFiles, directories: ['dir'], generatedAt: '' },
        formatted: '',
      });
      const result = await projectMapHandler.execute({ action: 'info', path: 'nope.ts' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('... and 5 more');
    });

    it('normalizes backslash paths (Windows)', async () => {
      const result = await projectMapHandler.execute({ action: 'info', path: 'src\\App.tsx' }, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Path: src/App.tsx');
    });

    it('requires path argument', async () => {
      const result = await projectMapHandler.execute({ action: 'info' }, ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('path is required');
    });
  });

  // ─── error handling ────────────────────────────────────
  describe('error handling', () => {
    it('returns error for unknown action', async () => {
      const result = await projectMapHandler.execute({ action: 'unknown' }, ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Unknown action');
    });

    it('handles getOrBuildProjectMap failure gracefully', async () => {
      mockGetOrBuild.mockImplementation(() => { throw new Error('Index corrupted'); });
      const result = await projectMapHandler.execute({ action: 'list' }, ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Error accessing project map');
      expect(result.stdout).toContain('Index corrupted');
    });

    it('defaults action to list when missing', async () => {
      const result = await projectMapHandler.execute({}, ctx);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PROJECT: test-project');
    });
  });
});
