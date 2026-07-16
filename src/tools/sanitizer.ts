const DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//i,
  /:\(\)\s*\{[^}]*\}.*:/,
  /chmod\s+777/i,
  /dd\s+if=.*of=\/dev\//i,
  />\s*\/dev\/(sda|sdb|sdc|nvme)/i,
  /mkfs\./i,
  /fdisk\s+\/dev\//i,
  /dd\s+if=\/dev\/zero/i,
];

const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'find',
  'git log', 'git status', 'git diff', 'git show',
  'npm ls', 'npm list',
]);

function stripWrappers(cmd: string): string {
  return cmd.replace(/^(timeout|time|nice)\s+(-\w+\s+)?/i, '');
}

function parseCommands(cmd: string): string[] {
  const parts = cmd.split(/\s*&&\s*|\s*\|\|\s*|\s*;\s*/);
  const result: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) result.push(trimmed);
  }
  return result;
}

function getCommandName(cmd: string): string {
  const match = cmd.match(/^(?:npx\s+|sudo\s+|doas\s+)?(\S+)/);
  return match ? match[1] : cmd;
}

export interface SanitizeResult {
  safe: boolean;
  reason?: string;
  readOnly: boolean;
}

export function sanitize(cmd: string): SanitizeResult {
  const stripped = stripWrappers(cmd);
  const subCommands = parseCommands(stripped);

  for (const sub of subCommands) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(sub)) {
        return { safe: false, reason: `Command matches dangerous pattern: ${pattern}`, readOnly: false };
      }
    }
  }

  const firstCmd = getCommandName(stripped);
  const readOnly = subCommands.every(sub => {
    const name = getCommandName(sub);
    return READ_ONLY_COMMANDS.has(name);
  });

  return { safe: true, readOnly };
}
