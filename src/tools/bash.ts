import { execa, ExecaError } from 'execa';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitize } from './sanitizer.js';
import { getTheme } from '../styling/index.js';

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

const MAX_OUTPUT_LENGTH = 2000;
const CACHE_DIR = join(homedir(), '.mma', 'cache');

const UNIX_TO_PWSH: [RegExp, string][] = [
  [/^ls\s+-la/, 'dir'],
  [/^ls\s+/, 'dir '],
  [/^cat\s+/, 'Get-Content '],
  [/^rm\s+/, 'Remove-Item -Force '],
  [/^mv\s+/, 'Move-Item '],
  [/^cp\s+/, 'Copy-Item '],
  [/^mkdir\s+-p\s+/, 'New-Item -ItemType Directory -Force -Path '],
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

function translateToPowerShell(cmd: string): string {
  for (const [pattern, replacement] of UNIX_TO_PWSH) {
    if (pattern.test(cmd)) {
      return cmd.replace(pattern, replacement);
    }
  }
  return cmd;
}

function encodePowerShellCommand(cmd: string): string {
  const utf16le = Buffer.from(cmd, 'utf16le');
  return utf16le.toString('base64');
}

export async function executeBash(cmd: string, timeoutSeconds: number = 120): Promise<BashResult> {
  cmd = translateToPowerShell(cmd);
  if (!sanitize(cmd).safe) {
    const theme = getTheme();
    return { stdout: '', stderr: theme.error(`Blocked by sanitizer`), exitCode: 1, truncated: false };
  }

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
