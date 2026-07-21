import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentPlugin, PluginContext } from '../../types.js';

/**
 * Плагин lint-on-write.
 *
 * После каждого write_file/edit_file запускает линтер
 * и добавляет ошибки в tool result (модель видит их сразу).
 *
 * Линтер определяется автоматически (eslint → biome → prettier).
 *
 * @module plugins/builtin/lint-on-write
 */

const LINTER_DETECT_COMMANDS = [
  { name: 'eslint', cmd: 'npx eslint --version' },
  { name: 'biome', cmd: 'npx @biomejs/biome --version' },
  { name: 'prettier', cmd: 'npx prettier --version' },
];

function detectLinter(cwd: string, cacheFile: string): string | null {
  const cachePath = join(cwd, cacheFile);
  if (existsSync(cachePath)) {
    try {
      const cached = readFileSync(cachePath, 'utf-8').trim();
      if (cached) return cached;
    } catch { /* ignore */ }
  }
  for (const { name, cmd } of LINTER_DETECT_COMMANDS) {
    try {
      execSync(cmd, { cwd, timeout: 5000, windowsHide: true, stdio: 'pipe' });
      try { writeFileSync(cachePath, name, 'utf-8'); } catch { /* ignore */ }
      return name;
    } catch { /* not found */ }
  }
  return null;
}

function runLinter(linter: string, filePath: string, cwd: string): string | null {
  try {
    let cmd: string;
    switch (linter) {
      case 'eslint': cmd = `npx eslint "${filePath}" --format compact`; break;
      case 'biome': cmd = `npx @biomejs/biome check "${filePath}"`; break;
      case 'prettier': cmd = `npx prettier --check "${filePath}"`; break;
      default: return null;
    }
    execSync(cmd, { cwd, timeout: 15000, windowsHide: true, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return null;
  } catch (e: any) {
    const output = e.stdout?.toString() || e.stderr?.toString() || '';
    return output ? output.slice(0, 1000) : null;
  }
}

// Module-level linter cache
let cachedLinter: string | null = null;

export default function createLintOnWrite(): AgentPlugin {
  return {
    name: 'lint-on-write',
    version: '1.0.0',
    description: 'Auto-run linter after write_file/edit_file',
    onActivate(ctx: PluginContext) {
      ctx.logger.info('lint-on-write: active (linter detected on first file write)');
    },
    on(_event: string, _handler: any) { /* via PluginManager.on() */ },
    onDeactivate() { cachedLinter = null; },
    getPromptSection() {
      return '## Lint-on-Write Plugin\nAfter writing/editing .ts/.tsx/.js/.jsx files, lint errors (if any) are automatically appended to the tool result.';
    },
  };
}

/**
 * Обработчик tool:after — вызывается через PluginManager.on().
 * Экспортируется для регистрации в loop.ts.
 */
export function handleToolAfter(
  toolName: string,
  args: Record<string, unknown>,
  _result: { stdout: string; stderr: string; exitCode: number },
  cwd: string,
  cacheFile: string,
): string | null {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return null;
  const filePath = String(args.path ?? '');
  if (!filePath || !/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return null;

  const linter = cachedLinter ?? detectLinter(cwd, cacheFile);
  if (!linter) return null;
  cachedLinter = linter;

  return runLinter(linter, filePath, cwd);
}