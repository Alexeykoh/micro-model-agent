import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SyntaxCheckResult {
  file: string;
  valid: boolean;
  errors: string[];
  language: string;
}

// TypeScript/JavaScript syntax check via tsc
function checkTypeScriptSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'], language: 'typescript' };
  }

  try {
    execSync(`npx tsc --noEmit --pretty false "${fullPath}"`, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { file: filePath, valid: true, errors: [], language: 'typescript' };
  } catch (e: any) {
    const stderr = e.stderr || e.stdout || '';
    const fileBase = filePath.replace(/\\/g, '/').split('/').pop() || '';
    const errors = stderr
      .split('\n')
      .filter((line: string) => line.includes('error TS') && line.includes(fileBase))
      .slice(0, 5)
      .map((line: string) => line.trim());
    return { file: filePath, valid: errors.length === 0, errors, language: 'typescript' };
  }
}

// JavaScript syntax check via esprima
function checkJavaScriptSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'], language: 'javascript' };
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    // Use esprima to parse
    const esprima = require('esprima');
    esprima.parseScript(content);
    return { file: filePath, valid: true, errors: [], language: 'javascript' };
  } catch (e: any) {
    const errorMsg = e.message || 'Unknown syntax error';
    const line = e.lineNumber ? `line ${e.lineNumber}: ` : '';
    return {
      file: filePath,
      valid: false,
      errors: [`${line}${errorMsg}`],
      language: 'javascript',
    };
  }
}

// JSON syntax check
function checkJsonSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'], language: 'json' };
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    JSON.parse(content);
    return { file: filePath, valid: true, errors: [], language: 'json' };
  } catch (e: any) {
    const errorMsg = e.message || 'Invalid JSON';
    return { file: filePath, valid: false, errors: [errorMsg], language: 'json' };
  }
}

// Python syntax check via pyright (if available)
function checkPythonSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'], language: 'python' };
  }

  try {
    execSync(`npx pyright "${fullPath}" --outputjson`, {
      encoding: 'utf-8',
      timeout: 15000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { file: filePath, valid: true, errors: [], language: 'python' };
  } catch (e: any) {
    const stderr = e.stderr || e.stdout || '';
    const errors = stderr
      .split('\n')
      .filter((line: string) => line.includes('error:'))
      .slice(0, 5)
      .map((line: string) => line.trim());
    return { file: filePath, valid: errors.length === 0, errors, language: 'python' };
  }
}

// HTML syntax check (basic)
function checkHtmlSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'], language: 'html' };
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    // Basic HTML validation - check for unclosed tags
    const openTags = (content.match(/<([a-z][a-z0-9]*)\b/gi) || []).length;
    const closeTags = (content.match(/<\/([a-z][a-z0-9]*)\b/gi) || []).length;
    const selfClosing = (content.match(/\/>/g) || []).length;

    if (Math.abs(openTags - closeTags) > selfClosing + 5) {
      return {
        file: filePath,
        valid: false,
        errors: ['Possible unclosed HTML tags'],
        language: 'html',
      };
    }
    return { file: filePath, valid: true, errors: [], language: 'html' };
  } catch (e: any) {
    return { file: filePath, valid: false, errors: [e.message], language: 'html' };
  }
}

// CSS syntax check (basic)
function checkCssSyntax(filePath: string, cwd: string): SyntaxCheckResult {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) {
    return { file: filePath, valid: false, errors: ['File not found'], language: 'css' };
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    // Basic CSS validation - check bracket balance
    let braces = 0;
    for (const ch of content) {
      if (ch === '{') braces++;
      if (ch === '}') braces--;
    }
    if (braces !== 0) {
      return {
        file: filePath,
        valid: false,
        errors: [`Unbalanced braces: ${braces > 0 ? 'missing ' + braces + ' closing' : 'extra ' + Math.abs(braces) + ' closing'}`],
        language: 'css',
      };
    }
    return { file: filePath, valid: true, errors: [], language: 'css' };
  } catch (e: any) {
    return { file: filePath, valid: false, errors: [e.message], language: 'css' };
  }
}

// Main syntax check function
export function checkFileSyntax(filePath: string, cwd: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  let result: SyntaxCheckResult;

  switch (ext) {
    case 'ts':
    case 'tsx':
      result = checkTypeScriptSyntax(filePath, cwd);
      break;
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      result = checkJavaScriptSyntax(filePath, cwd);
      break;
    case 'json':
      result = checkJsonSyntax(filePath, cwd);
      break;
    case 'py':
      result = checkPythonSyntax(filePath, cwd);
      break;
    case 'html':
    case 'htm':
      result = checkHtmlSyntax(filePath, cwd);
      break;
    case 'css':
    case 'scss':
    case 'less':
      result = checkCssSyntax(filePath, cwd);
      break;
    default:
      return 'OK';
  }

  if (result.valid) {
    return 'OK';
  }

  const issues: string[] = [];
  if (result.errors.length > 0) {
    issues.push(`${result.language} errors:\n${result.errors.map(e => `  ${e}`).join('\n')}`);
  }

  // Also check imports for JS/TS files
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    const importResult = checkImports(filePath, cwd);
    if (importResult.missing.length > 0) {
      issues.push(`Missing imports:\n${importResult.missing.map(i => `  ${i}`).join('\n')}`);
    }
  }

  return issues.length > 0 ? issues.join('\n') : 'OK';
}

// Import check
export function checkImports(filePath: string, cwd: string): { missing: string[] } {
  const fullPath = join(cwd, filePath);
  if (!existsSync(fullPath)) return { missing: [] };

  const content = readFileSync(fullPath, 'utf-8');
  const missing: string[] = [];

  // Match import statements (ES modules)
  const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];

    // Skip node_modules and npm packages
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    // Resolve relative import
    const dir = filePath.split(/[/\\]/).slice(0, -1).join('/');
    const resolved = join(cwd, dir, importPath);

    // Check if file exists
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', ''];
    const found = extensions.some(ext => existsSync(resolved + ext));

    if (!found) {
      missing.push(importPath);
    }
  }

  // Also check require() calls
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    const dir = filePath.split(/[/\\]/).slice(0, -1).join('/');
    const resolved = join(cwd, dir, importPath);
    const extensions = ['.js', '.json', '/index.js', ''];
    const found = extensions.some(ext => existsSync(resolved + ext));

    if (!found) {
      missing.push(importPath);
    }
  }

  return { missing };
}

// Check entire project
export function checkProjectSyntax(cwd: string): { total: number; errors: number; details: string[] } {
  try {
    execSync('npx tsc --noEmit --pretty false 2>&1', {
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
