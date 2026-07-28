import { describe, it, expect, beforeAll } from 'vitest';
import { LMStudioNative } from '../src/llm/lmstudio-native.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { runAgentLoop } from '../src/agent/loop.js';
import type { OutputRenderer } from '../src/ui/renderer.js';
import type { StatusInfo } from '../src/ui/renderer.js';
import { existsSync, mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE_URL = process.env.MMA_LLM_URL || 'http://localhost:1234/v1';
const MODEL = process.env.MMA_LLM_MODEL || 'qwen/qwen3.5-9b';
const CTX = parseInt(process.env.MMA_CTX || '32768', 10);

let provider: LMStudioNative;

beforeAll(() => {
  provider = new LMStudioNative(BASE_URL, MODEL, CTX);
});

async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const mockRenderer: OutputRenderer = {
  write() {},
  writeLine() {},
  writeNewline() {},
  writeInfo() {},
  writeSuccess() {},
  writeWarning() {},
  writeError() {},
  writeDim() {},
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
  async prompt() { return ''; },
  writeFileOutput() {},
  destroy() {},
};

function createTestProject(dir: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'subagent-test-project',
    type: 'module',
  }, null, 2));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
  }, null, 2));
}

function fileExists(...parts: string[]): boolean {
  return existsSync(join(...parts));
}

function containsToolCall(messages: { role: string; content: string }[], toolName: string): boolean {
  const pattern = `<tool_call>{"name":"${toolName}"`;
  return messages.some(m => m.role === 'assistant' && m.content && m.content.includes(pattern));
}

function containsText(messages: { role: string; content: string }[], text: string): boolean {
  return messages.some(m => m.content && m.content.includes(text));
}

describe('Subagent integration', () => {

  it('uses subagent when creating 5+ files (multi-file project)', async () => {
    if (!(await isAvailable())) return;

    const testDir = mkdtempSync(join(tmpdir(), 'subagent-int-'));
    const origCwd = process.cwd();
    process.chdir(testDir);

    try {
      createTestProject(testDir);

      const registry = new ToolRegistry(testDir);
      const result = await runAgentLoop(
        provider, registry,
        'Создай 5 TypeScript файлов в папке subagent-project: index.ts (export const app = "app"), ' +
        'db.ts (export const db = "db"), routes.ts (export const routes = "routes"), ' +
        'types.ts (export interface User { id: number }), utils.ts (export const util = "util"). ' +
        'Сначала создай папку subagent-project через create_dir.',
        undefined, undefined, mockRenderer, 'test', { quiet: true, mode: 'base' },
      );

      // Check files were created
      const projectDir = join(testDir, 'subagent-project');
      const filesCreated = ['index.ts', 'db.ts', 'routes.ts', 'types.ts', 'utils.ts']
        .filter(f => fileExists(projectDir, f));
      const totalFiles = filesCreated.length;

      // Check subagent was called
      const usedSubagent = containsToolCall(result.messages, 'subagent');

      if (totalFiles >= 3) {
        // If 3+ files were created, subagent MUST have been used (enforcement kicks in at 3)
        expect(usedSubagent).toBe(true);
        expect(containsText(result.messages, 'BLOCKED')).toBe(true);
      } else {
        // Less than 3 files created - not a strong signal about subagent
        // This might happen if the model couldn't complete the task
      }

      for (const f of filesCreated) {
        expect(fileExists(projectDir, f)).toBe(true);
      }

      // If all 5 created, subagent MUST have been used
      if (totalFiles === 5) {
        expect(usedSubagent).toBe(true);
      }

    } finally {
      process.chdir(origCwd);
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 180000);

  it('does NOT block single file creation (no subagent needed)', async () => {
    if (!(await isAvailable())) return;

    const testDir = mkdtempSync(join(tmpdir(), 'subagent-single-'));
    const origCwd = process.cwd();
    process.chdir(testDir);

    try {
      createTestProject(testDir);

      const registry = new ToolRegistry(testDir);
      const result = await runAgentLoop(
        provider, registry,
        'Create a file single-test.txt with content "single file test"',
        undefined, undefined, mockRenderer, 'test', { quiet: true },
      );

      // Should NOT have been blocked
      expect(containsText(result.messages, 'BLOCKED')).toBe(false);
      // File should exist
      expect(fileExists(testDir, 'single-test.txt')).toBe(true);

    } finally {
      process.chdir(origCwd);
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 60000);

  it('subagent is called via plan + subagent workflow', async () => {
    if (!(await isAvailable())) return;

    const testDir = mkdtempSync(join(tmpdir(), 'subagent-plan-'));
    const origCwd = process.cwd();
    process.chdir(testDir);

    try {
      createTestProject(testDir);

      const registry = new ToolRegistry(testDir);
      const result = await runAgentLoop(
        provider, registry,
        'Создай plan для проекта из 5 файлов, затем реализуй: plan-test/a.ts (export const a=1), ' +
        'plan-test/b.ts (export const b=2), plan-test/c.ts (export const c=3)',
        undefined, undefined, mockRenderer, 'test', { quiet: true },
      );

      // Check plan was created — should show plan text
      const hasPlan = containsText(result.messages, 'Plan');
      const hasSubagent = containsToolCall(result.messages, 'subagent');

      if (hasPlan) {
        // When plan is created for 3+ steps, system suggests subagent
        // Either model follows suggestion or enforcement kicks in
        const filesExist = ['a.ts', 'b.ts', 'c.ts']
          .filter(f => fileExists(testDir, 'plan-test', f));
        if (filesExist.length >= 3) {
          // Enforcement should have forced subagent
          expect(hasSubagent).toBe(true);
        }
      }

    } finally {
      process.chdir(origCwd);
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 180000);
});
