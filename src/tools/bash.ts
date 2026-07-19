import { execa, ExecaError } from 'execa';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitize } from './sanitizer.js';
import { getTheme } from '../styling/index.js';

/**
 * Исполнение shell-команд.
 *
 * Особенности:
 * - Автоматическая трансляция Unix-команд в PowerShell на Windows
 * - Санитайзинг опасных паттернов (rm -rf, fork bomb и т.д.)
 * - Автосоздание директорий для Set-Content
 * - Ограничение длины вывода (8000 символов)
 * - Логирование в файл для отладки
 *
 * @module tools/bash
 */

/** Результат выполнения bash-команды */
export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

const MAX_OUTPUT_LENGTH = 8000; // максимальная длина вывода (обрезается)
const CACHE_DIR = join(homedir(), '.mma', 'cache');

// ─── Трансляция Unix → PowerShell ─────────────────────────
// Автоматически конвертирует стандартные Unix-команды в PowerShell-эквиваленты
const UNIX_TO_PWSH: [RegExp, string | ((match: RegExpMatchArray) => string)][] = [
  [/^ls\s+-la/, 'dir'],
  [/^ls\s+/, 'dir '],
  [/^cat\s+/, 'Get-Content '],
  [/^rm\s+/, 'Remove-Item -Force '],
  [/^mv\s+/, 'Move-Item '],
  [/^cp\s+/, 'Copy-Item '],
  [/^mkdir\s+-p\s+(.+)/, (match: RegExpMatchArray) => {
    // Handle multiple directories: mkdir -p dir1 dir2 dir3
    const dirs = match[1].split(/\s+/).filter(Boolean);
    return dirs.map(d => `New-Item -ItemType Directory -Force -Path "${d}"`).join('; ');
  }],
  [/^mkdir\s+/, 'New-Item -ItemType Directory -Path '],
  [/^touch\s+/, 'New-Item -ItemType File -Force -Path '],
  [/^grep\s+/, "Select-String -Pattern "],
  [/^wc\s+/, 'Measure-Object -Line '],
  [/^head\s+/, 'Get-Content -TotalCount '],
  [/^tail\s+/, 'Get-Content -Tail '],
  [/^echo\s+-e\s+/, 'Write-Output '],
  [/^echo\s+/, 'Write-Output '],
  [/^pwd\s*$/, 'Get-Location'],
  [/^which\s+/, 'Get-Command '],
  [/^find\s+/, 'Get-ChildItem -Recurse -Filter '],
  [/^chmod\s+/, '# chmod not needed on Windows -- '],
];

function expandBraces(cmd: string): string {
  // Expand bash-style brace expansion: dir\{a,b,c} -> dir\a
  // PowerShell script blocks { ... } and hashtables @{ ... } must NOT be touched
  return cmd.replace(/\{([^{}]*,[^{}]*)\}/g, (_, inner) => {
    const items = inner.split(',').map((s: string) => s.trim());
    return items[0] || '';
  });
}

function needsBraceExpansion(cmd: string): boolean {
  // Only expand if the pattern looks like a bash brace expansion (contains comma)
  return /\{[^{}]*,[^{}]*\}/.test(cmd);
}

function translateToPowerShell(cmd: string): string {
  // Expand bash-style brace expansions (but NOT PowerShell { } blocks or @{ } hashtables)
  if (needsBraceExpansion(cmd)) {
    cmd = expandBraces(cmd);
  }

  for (const [pattern, replacement] of UNIX_TO_PWSH) {
    if (pattern.test(cmd)) {
      if (typeof replacement === 'function') {
        const match = cmd.match(pattern);
        if (match) return replacement(match);
      } else {
        return cmd.replace(pattern, replacement);
      }
    }
  }
  return cmd;
}

function ensureDirectoryExists(cmd: string, cwd: string): void {
  // Auto-create directory for Set-Content commands
  const match = cmd.match(/Set-Content\s+-Path\s+['"]?([^'"]+?)['"]?\s+-Value/i);
  if (match) {
    let filePath = match[1];
    // Fix common path issues: blog-api\src\file.ts -> blog-api/src/file.ts
    filePath = filePath.replace(/\\/g, '/');
    const dir = filePath.split('/').slice(0, -1).join('/');
    if (dir) {
      const fullDir = join(cwd, dir);
      if (!existsSync(fullDir)) {
        mkdirSync(fullDir, { recursive: true });
      }
    }
  }
}

function fixJsonContent(cmd: string): string {
  // Fix backslashes in JSON content that break JSON parsing
  // Problem: "dist\index.js" -> "dist\\index.js" or "dist/index.js"
  return cmd.replace(
    /(-Value\s+['"])(.*?)(['"])/gs,
    (match, prefix, content, suffix) => {
      // Replace \ with / in content (except for valid JSON escapes like \n, \t, \")
      const fixed = content
        .replace(/\\([^nrtbf"\\])/g, '/$1')  // \i -> /i, but keep \n \t etc
        .replace(/\\\\/g, '/');               // \\ -> /
      return prefix + fixed + suffix;
    }
  );
}

function fixCommonPathIssues(cmd: string): string {
  // Fix: blog-api\src\file.ts -> blog-api/src/file.ts (normalize slashes)
  // Fix: blog-apifile.ts -> blog-api/file.ts (missing slash)
  let fixed = cmd;

  // Fix missing slash between folder and file: "blog-api\package.json" -> "blog-api/package.json"
  // But only if it looks like a path issue (no slash between folder name and file)
  fixed = fixed.replace(/(['"])(\w+)-(\w+)\\(\w+\.\w+)/g, '$1$2-$3/$4');

  return fixed;
}

function encodePowerShellCommand(cmd: string): string {
  const utf16le = Buffer.from(cmd, 'utf16le');
  return utf16le.toString('base64');
}

function cleanCliXml(text: string): string {
  // Remove CLIXML wrapper and ANSI codes
  if (!text.includes('#< CLIXML') && !text.includes('<Objs')) return text;

  // Extract error messages from CLIXML
  const errors: string[] = [];
  const regex = /<S S="Error">(.*?)<\/S>/gs;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Remove ANSI codes and CLIXML entities
    let msg = match[1]
      .replace(/_x001B_\[[0-9;]*m/g, '')  // ANSI codes
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .trim();
    if (msg && !errors.includes(msg)) {
      errors.push(msg);
    }
  }

  return errors.length > 0 ? errors.join('\n') : text;
}

export async function executeBash(cmd: string, timeoutSeconds: number = 120): Promise<BashResult> {
  // Block recursive calls to MMA itself
  if (/\bmma\b/.test(cmd) && /\brun\b/.test(cmd)) {
    return { stdout: '', stderr: 'Blocked: recursive MMA call detected. Use filesystem tools instead.', exitCode: 1, truncated: false };
  }



  cmd = fixCommonPathIssues(cmd);
  cmd = fixJsonContent(cmd);
  cmd = translateToPowerShell(cmd);
  if (!sanitize(cmd).safe) {
    const theme = getTheme();
    return { stdout: '', stderr: theme.error(`Blocked by sanitizer`), exitCode: 1, truncated: false };
  }

  // Auto-create directory for file write commands
  ensureDirectoryExists(cmd, process.cwd());

  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }

  const cacheId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cacheFile = join(CACHE_DIR, `${cacheId}.out`);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  const encoded = encodePowerShellCommand(cmd);

  try {
    const result = await execa('pwsh', ['-NoProfile', '-EncodedCommand', encoded], {
      timeout: timeoutSeconds * 1000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      encoding: 'utf8',
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode ?? 0;
  } catch (e: any) {
    if (e instanceof ExecaError) {
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      exitCode = e.exitCode ?? 1;
    } else {
      stderr = String(e);
      exitCode = 1;
    }
  }

  // Clean CLIXML from stderr
  stderr = cleanCliXml(stderr);

  writeFileSync(cacheFile, stdout, 'utf-8');

  let truncated = false;
  if (stdout.length > MAX_OUTPUT_LENGTH) {
    stdout = stdout.slice(0, MAX_OUTPUT_LENGTH) + `\n... (полный вывод сохранён в ${cacheFile})`;
    truncated = true;
  }

  if (stderr.length > MAX_OUTPUT_LENGTH) {
    stderr = stderr.slice(0, MAX_OUTPUT_LENGTH);
  }

  return { stdout, stderr, exitCode, truncated };
}
