import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { executeBash } from './tools/bash.js';
import type { LLMProvider } from './llm/provider.js';
import { ToolRegistry } from './tools/registry.js';
import { runAgentLoop } from './agent/loop.js';
import { loadMemory, saveMemory, searchMemory, loadAllMemory, ensureMemoryDir, removeMemoryEntry, exportMemory } from './agent/memory.js';
import { listInstalledSkills } from './skills/loader.js';
import { listSessions, loadSession, createNamedSession, createAutoSession, formatSessionList } from './session/store.js';
import { rebuildCodeIndex, rebuildProjectMap } from './indexer/cache.js';

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
    const IGNORE = ['node_modules', '.git', 'dist', '.mma', 'build', '__pycache__'];
    const fixedPattern = pattern.includes('/') || pattern.includes('\\') ? pattern : `**/${pattern}`;
    const results = (globSync(fixedPattern) as string[]).filter(f => !f.split(/[/\\]/).some(p => IGNORE.includes(p)));
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

function slashEdit(args: string): void {
  const parts = args.split(/\s+/);
  if (parts.length < 3) {
    console.log('  Usage: /edit <file> <line> <new content>');
    console.log('  Example: /edit src/index.ts 5 const x = 1;');
    return;
  }
  const [filePath, lineStr, ...rest] = parts;
  const lineNum = parseInt(lineStr, 10);
  if (isNaN(lineNum) || lineNum < 1) {
    console.log('  Line number must be a positive integer');
    return;
  }
  const newContent = rest.join(' ');
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lineNum > lines.length) {
      console.log(`  File has only ${lines.length} lines`);
      return;
    }
    lines[lineNum - 1] = newContent;
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    console.log(`  ✓ Line ${lineNum} updated in ${filePath}`);
  } catch (e: any) {
    console.error(`  Error: ${e.message}`);
  }
}

async function slashBash(cmd: string): Promise<void> {
  const result = await executeBash(cmd);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
}

function slashSkill(args: string): void {
  const subcmd = args.trim() || 'list';
  switch (subcmd) {
    case 'list': {
      const skills = listInstalledSkills();
      if (skills.length === 0) {
        console.log('  No skills installed.');
        console.log('  Skills are loaded from: ~/.mma/skills/, ~/.claude/skills/, .claude/skills/, .agents/skills/');
        console.log('  Reference skills in prompts with @skill-name');
      } else {
        console.log(`  Installed skills (${skills.length}):`);
        for (const s of skills) {
          console.log(`    @${s}`);
        }
      }
      break;
    }
    default:
      console.log('  Usage: /skill [list]');
  }
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
    case 'remove': {
      if (!type) {
        console.log('  Usage: /memory remove <type> <line-number>');
        console.log('  First use /memory show <type> to see entries with line numbers.');
        return;
      }
      const lineNum = parseInt(text, 10);
      if (isNaN(lineNum) || lineNum < 1) {
        console.log('  Line number must be a positive integer');
        return;
      }
      const removed = removeMemoryEntry(type, lineNum);
      if (removed) {
        console.log(`  ✓ Entry removed from ${type}.md`);
      } else {
        console.log('  Could not remove entry (line number out of range?)');
      }
      break;
    }
    case 'export': {
      const exported = exportMemory();
      if (exported) {
        console.log(`  ✓ Memory exported to ${exported}`);
      } else {
        console.log('  No memory to export');
      }
      break;
    }
    default: {
      console.log('  Usage: /memory [show <type>|add <type> <text>|search <query>|remove <type> <line>|export]');
    }
  }
}

function slashSessions(): void {
  const sessions = listSessions();
  console.log(formatSessionList(sessions));
}

async function slashResume(args: string, provider: LLMProvider, registry: ToolRegistry): Promise<void> {
  if (!args.trim()) {
    console.log('  Usage: /resume <session-id>');
    console.log('  Use /sessions to see available sessions.');
    return;
  }
  const session = loadSession(args.trim());
  if (!session) {
    console.log(`  Session "${args.trim()}" not found.`);
    return;
  }
  console.log(`  Resumed session: ${session.id} (${session.messages.length} messages)`);
  console.log(`  Provider: ${session.provider}`);
  console.log();
  // Replay with session context
  const lastUser = session.messages.filter(m => m.role === 'user').pop();
  const prevMsgs = session.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content }));
  if (lastUser) {
    await runAgentLoop(provider, registry, lastUser.content, undefined, prevMsgs);
  }
}

function slashSave(args: string, history: { role: 'user' | 'assistant'; content: string }[], provider: LLMProvider): void {
  if (history.length === 0) {
    console.log('  No conversation to save.');
    return;
  }
  const name = args.trim() || '';
  const providerLabel = `${provider.model}`;
  const filePath = createNamedSession(name, history, providerLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
  const id = filePath.split(/[/\\]/).pop()?.replace('.json', '') || '';
  console.log(`  ✓ Session saved: ${id}${name ? ` (${name})` : ''}`);
}

function slashClear(history: { role: string; content: string }[]): void {
  history.length = 0;
  console.log('  Context cleared. Starting new session.');
}

function slashIndex(args: string): void {
  const subcmd = args.trim() || 'status';
  switch (subcmd) {
    case 'rebuild': {
      console.log('  Rebuilding code index...');
      const { formatted } = rebuildCodeIndex(process.cwd());
      console.log(formatted);
      console.log('  ✓ Code index rebuilt');
      break;
    }
    case 'map': {
      console.log('  Rebuilding project map...');
      const { formatted } = rebuildProjectMap(process.cwd());
      console.log(formatted);
      console.log('  ✓ Project map rebuilt');
      break;
    }
    case 'status': {
      const { getOrBuildCodeIndex, getOrBuildProjectMap } = require('./indexer/cache.js');
      const { formatted: mapFormatted } = getOrBuildProjectMap(process.cwd());
      const { formatted: idxFormatted } = getOrBuildCodeIndex(process.cwd());
      console.log(mapFormatted.split('\n').slice(0, 3).join('\n'));
      console.log();
      console.log(idxFormatted.split('\n').slice(0, 3).join('\n'));
      break;
    }
    default:
      console.log('  Usage: /index [status|rebuild|map]');
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
  let conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];
  let closed = false;
  rl.on('close', () => { closed = true; });

  // Auto-save on SIGINT (Ctrl+C)
  process.on('SIGINT', () => {
    if (conversationHistory.length > 0) {
      createAutoSession(conversationHistory, modelLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
      console.log('\n  Session auto-saved.');
    }
    rl.close();
    process.exit(0);
  });

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
          if (conversationHistory.length > 0) {
            createAutoSession(conversationHistory, modelLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
            console.log('  Session auto-saved.');
          }
          console.log('Bye!');
          rl.close();
          return;
        case 'help':
          console.log(`
  /bash <cmd>       — run shell command
  /read <file>      — display file with line numbers
  /edit <file> <n>  — replace line N in file with rest of args
  /write <file>     — write file (end with EOF on its own line)
  /find <pattern>   — find files by glob pattern
  /search <pattern> — search file contents
  /git <args>       — git operations
  /memory           — show memory summary
  /memory show <t>  — show memory type content
  /memory add <t>   — add memory entry
  /memory search <q> — search memory
  /memory remove <t> <n> — remove entry N from type
  /memory export    — export memory to .mma/memory-export.md
  /skill            — list installed skills
  /sessions         — list saved sessions
  /resume <id>      — resume a session
  /save [name]      — save current session
  /clear            — clear context (new session)
  /index [cmd]      — index status/rebuild/map
  /exit             — exit MMA
          `);
          break;
        case 'bash':
          await slashBash(args);
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
        case 'edit':
          slashEdit(args);
          break;
        case 'find':
          slashFind(args);
          break;
        case 'search':
          slashSearch(args);
          break;
        case 'git':
          await slashBash(`git ${args}`);
          break;
        case 'memory':
          slashMemory(args);
          break;
        case 'skill':
          slashSkill(args);
          break;
        case 'sessions':
          slashSessions();
          break;
        case 'resume':
          await slashResume(args, provider, registry);
          break;
        case 'save':
          slashSave(args, conversationHistory, provider);
          break;
        case 'clear':
        case 'new':
          slashClear(conversationHistory);
          break;
        case 'index':
          slashIndex(args);
          break;
        default:
          console.log(`  Unknown command: /${cmd}. Type /help`);
      }
      continue;
    }

    const newMessages = await runAgentLoop(provider, registry, line, undefined, conversationHistory);
    // Keep system prompt out of history, only store user/assistant/tool
    for (const msg of newMessages) {
      if (msg.role !== 'system') {
        conversationHistory.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }
  }
}
