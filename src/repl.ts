import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { executeBash } from './tools/bash.js';
import type { LLMProvider } from './llm/provider.js';
import { ToolRegistry } from './tools/registry.js';
import { runAgentLoop } from './agent/loop.js';
import { loadMemory, saveMemory, searchMemory, loadAllMemory, ensureMemoryDir } from './agent/memory.js';

function slashRead(path: string): void {
  try {
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');
    const maxLines = 200;
    console.log();
    for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
      console.log(`${(i + 1).toString().padStart(4)}| ${lines[i]}`);
    }
    if (lines.length > maxLines) {
      console.log(`  ... (${lines.length - maxLines} more lines)`);
    }
    console.log();
  } catch (e: any) {
    console.error(`  Error: ${e.message}`);
  }
}

function slashFind(pattern: string): void {
  try {
    const results = globSync(pattern) as string[];
    if (results.length === 0) {
      console.log('  No matches');
      return;
    }
    for (const f of results) {
      console.log(`  ${f}`);
    }
  } catch (e: any) {
    console.error(`  Error: ${e.message}`);
  }
}

function slashSearch(pattern: string): void {
  try {
    const result = execSync(`findstr /s /n /c:"${pattern}" *.ts *.js *.tsx *.jsx *.json *.md`, { encoding: 'utf-8', timeout: 10000 });
    const lines = result.trim().split('\n').slice(0, 30);
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      console.log('  No matches');
      return;
    }
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    if (result.trim().split('\n').length > 30) {
      console.log(`  ... (${result.trim().split('\n').length - 30} more)`);
    }
  } catch (e: any) {
    if (e.status === 1) {
      console.log('  No matches');
    } else {
      console.error(`  Error: ${e.message}`);
    }
  }
}

function slashWrite(path: string, content: string): void {
  try {
    writeFileSync(path, content, 'utf-8');
    console.log(`  ✓ written to ${path}`);
  } catch (e: any) {
    console.error(`  Error: ${e.message}`);
  }
}

function slashBash(cmd: string): void {
  const result = executeBash(cmd);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
}

function slashMemory(args: string): void {
  ensureMemoryDir();

  if (!args.trim()) {
    const summary = loadAllMemory();
    if (summary) {
      console.log(summary);
    } else {
      console.log('  Project memory is empty. Use /memory add <type> <text>');
    }
    return;
  }

  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0];
  const rest = parts.slice(1);
  const type = rest[0] || '';
  const text = rest.slice(1).join(' ') || '';

  switch (subcommand) {
    case 'show': {
      if (!type) {
        console.log('  Usage: /memory show <type> (project|conventions|decisions|errors|history)');
        return;
      }
      const content = loadMemory(type);
      console.log();
      console.log(content);
      console.log();
      break;
    }
    case 'add': {
      if (!type || !text) {
        console.log('  Usage: /memory add <type> <text>');
        console.log('  Types: project, conventions, decisions, errors, history');
        return;
      }
      saveMemory(type, text.slice(0, 60), text);
      console.log(`  ✓ Saved to .mma/memory/${type}.md`);
      break;
    }
    case 'search': {
      if (!type) {
        console.log('  Usage: /memory search <query>');
        return;
      }
      const results = searchMemory(type);
      if (results.length === 0) {
        console.log('  No matches');
        return;
      }
      console.log(`  Found ${results.length} matches:`);
      for (const r of results) {
        console.log(`  [${r.type}] ${r.match}`);
      }
      break;
    }
    default: {
      console.log('  Usage: /memory [show <type>|add <type> <text>|search <query>]');
    }
  }
}

export async function runRepl(provider: LLMProvider, registry: ToolRegistry, modelLabel: string): Promise<void> {
  const rl = createInterface({ input, output, prompt: '' });

  const memorySummary = loadAllMemory();

  console.log(`MMA v0.1 — ${modelLabel}`);
  if (memorySummary) {
    console.log(memorySummary);
  }
  console.log('Type /help for commands, /exit to quit');
  console.log();

  let currentWritePath: string | null = null;
  let writeBuffer: string[] = [];
  let closed = false;
  rl.on('close', () => { closed = true; });

  while (!closed) {
    let line: string;
    try {
      line = await rl.question('MMA> ');
    } catch {
      return;
    }

    if (!line.trim()) continue;

    if (currentWritePath) {
      if (line.trim() === 'EOF') {
        slashWrite(currentWritePath, writeBuffer.join('\n'));
        currentWritePath = null;
        writeBuffer = [];
      } else {
        writeBuffer.push(line);
      }
      continue;
    }

    if (line.startsWith('/')) {
      const spaceIdx = line.indexOf(' ');
      const cmd = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);

      switch (cmd) {
        case 'exit':
        case 'quit':
          console.log('Bye!');
          rl.close();
          return;
        case 'help':
          console.log(`
  /bash <cmd>       — run shell command
  /read <file>      — display file with line numbers
  /write <file>     — write file (end with EOF on its own line)
  /find <pattern>   — find files by glob pattern
  /search <pattern> — search file contents
  /git <args>       — git operations
  /memory           — show memory summary
  /memory show <t>  — show memory type content
  /memory add <t>   — add memory entry
  /memory search <q> — search memory
  /exit             — exit MMA
          `);
          break;
        case 'bash':
          slashBash(args);
          break;
        case 'read':
          slashRead(args);
          break;
        case 'write':
          if (!args) {
            console.log('  Usage: /write <file>  (then type content, end with EOF)');
          } else {
            currentWritePath = args;
            console.log('  Type your content. End with EOF on its own line:');
          }
          break;
        case 'find':
          slashFind(args);
          break;
        case 'search':
          slashSearch(args);
          break;
        case 'git':
          slashBash(`git ${args}`);
          break;
        case 'memory':
          slashMemory(args);
          break;
        default:
          console.log(`  Unknown command: /${cmd}. Type /help`);
      }
      continue;
    }

    await runAgentLoop(provider, registry, line);
  }
}
