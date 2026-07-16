import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SyntaxCheckResult {
  file: string;
  valid: boolean;
  errors: string[];
}

export function checkTypeScriptSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'] };
  }

  try {
    execSync(`npx tsc --noEmit --pretty false "${fullPath}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { file: filePath, valid: true, errors: [] };
  } catch (e: any) {
    const stderr = e.stderr || e.stdout || '';
    // Filter errors to only this file
    const fileBase = filePath.replace(/\\/g, '/').split('/').pop() || '';
    const errors = stderr
      .split('\n')
      .filter((line: string) => line.includes('error TS') && line.includes(fileBase))
      .slice(0, 5)
      .map((line: string) => line.trim());
    return { file: filePath, valid: errors.length === 0, errors };
  }
}

export function checkImports(filePath: string, cwd: string): { missing: string[] } {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) return { missing: [] };

  const content = readFileSync(fullPath, 'utf-8');
  const missing: string[] = [];

  // Match import statements
  const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];

    // Skip node_modules and npm packages
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    // Resolve relative import
    const dir = filePath.split(/[/\\]/).slice(0, -1).join('/');
    const resolved = join(cwd, dir, importPath);

    // Check if file exists (try .ts, .tsx, .js, .jsx, /index.ts, /index.js, or no extension)
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', ''];
    const found = extensions.some(ext => existsSync(resolved + ext));

    if (!found) {
      missing.push(importPath);
    }
  }

  return { missing };
}

export function checkFileSyntax(filePath: string, cwd: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  if (ext === 'ts' || ext === 'tsx') {
    const tsResult = checkTypeScriptSyntax(filePath, cwd);
    const importResult = checkImports(filePath, cwd);

    const issues: string[] = [];
    if (!tsResult.valid) {
      issues.push(`TypeScript errors:\n${tsResult.errors.map(e => `  ${e}`).join('\n')}`);
    }
    if (importResult.missing.length > 0) {
      issues.push(`Missing imports:\n${importResult.missing.map(i => `  ${i}`).join('\n')}`);
    }

    return issues.length > 0 ? issues.join('\n') : 'OK';
  }

  return 'OK';
}

export function checkProjectSyntax(cwd: string): { total: number; errors: number; details: string[] } {
  try {
    const output = execSync('npx tsc --noEmit --pretty false 2>&1', {
      encoding: 'utf-8',
      timeout: 30000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { total: 0, errors: 0, details: [] };
  } catch (e: any) {
    const stderr = e.stderr || e.stdout || '';
    const errorLines = stderr
      .split('\n')
      .filter((line: string) => line.includes('error TS'))
      .slice(0, 10);

    return {
      total: errorLines.length,
      errors: errorLines.length,
      details: errorLines.map((l: string) => l.trim()),
    };
  }
}
