import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { executeBash } from '../tools/bash.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import { runAgentLoop } from '../agent/loop.js';
import { loadMemory, saveMemory, searchMemory, loadAllMemory, ensureMemoryDir, removeMemoryEntry, exportMemory } from '../agent/memory.js';
import { listInstalledSkills } from '../skills/loader.js';
import { listSessions, loadSession, createNamedSession, createAutoSession, formatSessionList } from '../session/store.js';
import { rebuildCodeIndex, rebuildProjectMap, getOrBuildCodeIndex, getOrBuildProjectMap } from '../indexer/cache.js';
import { getTheme } from '../styling/index.js';
import type { OutputRenderer } from '../ui/renderer.js';

type SlashHandler = (args: string, context: CommandContext) => Promise<void> | void;

export interface CommandContext {
  renderer: OutputRenderer;
  provider: LLMProvider;
  registry: ToolRegistry;
  history: { role: 'user' | 'assistant'; content: string }[];
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  modelLabel: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: SlashHandler;
}

export function getSlashCommands(): SlashCommand[] {
  return [
    { name: 'exit', description: 'exit MMA', handler: cmdExit },
    { name: 'quit', description: 'exit MMA', handler: cmdExit },
    { name: 'help', description: 'show help', handler: cmdHelp },
    { name: 'bash', description: 'run shell command', handler: cmdBash },
    { name: 'read', description: 'display file', handler: cmdRead },
    { name: 'write', description: 'write file (end with EOF)', handler: cmdWrite },
    { name: 'edit', description: 'replace line in file', handler: cmdEdit },
    { name: 'find', description: 'find files by glob', handler: cmdFind },
    { name: 'search', description: 'search file contents', handler: cmdSearch },
    { name: 'git', description: 'git operations', handler: cmdGit },
    { name: 'memory', description: 'memory management', handler: cmdMemory },
    { name: 'skill', description: 'list skills', handler: cmdSkill },
    { name: 'sessions', description: 'list sessions', handler: cmdSessions },
    { name: 'resume', description: 'resume session', handler: cmdResume },
    { name: 'save', description: 'save session', handler: cmdSave },
    { name: 'clear', description: 'clear context', handler: cmdClear },
    { name: 'new', description: 'clear context', handler: cmdClear },
    { name: 'stop', description: 'stop agent loop', handler: cmdStop },
    { name: 'index', description: 'index management', handler: cmdIndex },
    { name: 'export', description: 'export session (normal or debug)', handler: cmdExport },
  ];
}

export function parseSlashCommand(line: string): { cmd: string; args: string } | null {
  if (!line.startsWith('/')) return null;
  const spaceIdx = line.indexOf(' ');
  const cmd = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
  return { cmd, args };
}

function cmdExit(_args: string, ctx: CommandContext): void {
  if (ctx.conversationHistory.length > 0) {
    createAutoSession(ctx.conversationHistory, ctx.modelLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
    ctx.renderer.writeSuccess('Session auto-saved.');
  }
  ctx.renderer.writeDim('Bye!');
  ctx.renderer.destroy();
}

function cmdHelp(_args: string, ctx: CommandContext): void {
  ctx.renderer.writeDim(`
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
  /export [mode]    — export session (normal or debug)
  /index [cmd]      — index status/rebuild/map
  /stop             — stop agent loop
  /exit             — exit MMA
          `);
}

async function cmdBash(args: string, ctx: CommandContext): Promise<void> {
  const result = await executeBash(args);
  if (result.stdout) ctx.renderer.write(result.stdout);
  if (result.stderr) ctx.renderer.writeError(result.stderr);
}

function cmdRead(args: string, ctx: CommandContext): void {
  try {
    const content = readFileSync(args, 'utf-8');
    const lines = content.split('\n');
    const maxLines = 200;
    ctx.renderer.writeNewline();
    const shown = lines.slice(0, maxLines);
    ctx.renderer.writeFileOutput(shown);
    if (lines.length > maxLines) {
      ctx.renderer.writeDim(`  ... (${lines.length - maxLines} more lines)`);
    }
    ctx.renderer.writeNewline();
  } catch (e: any) {
    ctx.renderer.writeError(e.message);
  }
}

let _currentWritePath: string | null = null;
let _writeBuffer: string[] = [];

export function getWriteState() { return { path: _currentWritePath, buffer: _writeBuffer }; }
export function clearWriteState() { _currentWritePath = null; _writeBuffer = []; }
export function isWriteMode() { return _currentWritePath !== null; }

function cmdWrite(args: string, ctx: CommandContext): void {
  if (!args) {
    ctx.renderer.writeInfo('  Usage: /write <file>  (then type content, end with EOF)');
  } else {
    _currentWritePath = args;
    ctx.renderer.writeDim('  Type your content. End with EOF on its own line:');
  }
}

export function handleWriteLine(line: string, renderer: OutputRenderer): void {
  if (line.trim() === 'EOF') {
    const theme = getTheme();
    try {
      writeFileSync(_currentWritePath!, _writeBuffer.join('\n'), 'utf-8');
      renderer.writeSuccess(`written to ${theme.filePath(_currentWritePath!)}`);
    } catch (e: any) {
      renderer.writeError(theme.error(e.message));
    }
    _currentWritePath = null;
    _writeBuffer = [];
  } else {
    _writeBuffer.push(line);
  }
}

function cmdEdit(args: string, ctx: CommandContext): void {
  const parts = args.split(/\s+/);
  if (parts.length < 3) {
    ctx.renderer.writeInfo('  Usage: /edit <file> <line> <new content>');
    ctx.renderer.writeInfo('  Example: /edit src/index.ts 5 const x = 1;');
    return;
  }
  const [filePath, lineStr, ...rest] = parts;
  const lineNum = parseInt(lineStr, 10);
  if (isNaN(lineNum) || lineNum < 1) {
    ctx.renderer.writeDim('  Line number must be a positive integer');
    return;
  }
  const newContent = rest.join(' ');
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lineNum > lines.length) {
      ctx.renderer.writeWarning(`  File has only ${lines.length} lines`);
      return;
    }
    lines[lineNum - 1] = newContent;
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    const theme = getTheme();
    ctx.renderer.writeSuccess(`Line ${lineNum} updated in ${theme.filePath(filePath)}`);
  } catch (e: any) {
    ctx.renderer.writeError(e.message);
  }
}

function cmdFind(args: string, ctx: CommandContext): void {
  try {
    const IGNORE = ['node_modules', '.git', 'dist', '.mma', 'build', '__pycache__'];
    const fixedPattern = args.includes('/') || args.includes('\\') ? args : `**/${args}`;
    const results = (globSync(fixedPattern) as string[]).filter(f => !f.split(/[/\\]/).some(p => IGNORE.includes(p)));
    if (results.length === 0) {
      ctx.renderer.writeDim('  No matches');
      return;
    }
    const theme = getTheme();
    for (const f of results) {
      ctx.renderer.writeLine(`${theme.indent}${theme.filePath(f)}`);
    }
  } catch (e: any) {
    ctx.renderer.writeError(e.message);
  }
}

function cmdSearch(args: string, ctx: CommandContext): void {
  try {
    const result = execSync(`findstr /s /n /c:"${args}" *.ts *.js *.tsx *.jsx *.json *.md`, { encoding: 'utf-8', timeout: 10000 });
    const lines = result.trim().split('\n').slice(0, 30);
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      ctx.renderer.writeDim('  No matches');
      return;
    }
    const theme = getTheme();
    for (const line of lines) {
      ctx.renderer.writeLine(`${theme.indent}${line}`);
    }
    if (result.trim().split('\n').length > 30) {
      ctx.renderer.writeDim(`  ... (${result.trim().split('\n').length - 30} more)`);
    }
  } catch (e: any) {
    if ((e as any).status === 1) {
      ctx.renderer.writeDim('  No matches');
    } else {
      ctx.renderer.writeError((e as Error).message);
    }
  }
}

async function cmdGit(args: string, ctx: CommandContext): Promise<void> {
  const result = await executeBash(`git ${args}`);
  if (result.stdout) ctx.renderer.write(result.stdout);
  if (result.stderr) ctx.renderer.writeError(result.stderr);
}

function cmdMemory(args: string, ctx: CommandContext): void {
  ensureMemoryDir();
  const theme = getTheme();

  if (!args.trim()) {
    const summary = loadAllMemory();
    if (summary) {
      ctx.renderer.writeLine(summary);
    } else {
      ctx.renderer.writeDim('  Project memory is empty. Use /memory add <type> <text>');
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
        ctx.renderer.writeInfo('  Usage: /memory show <type> (project|conventions|decisions|errors|history)');
        return;
      }
      const content = loadMemory(type);
      ctx.renderer.writeNewline();
      ctx.renderer.writeLine(content);
      ctx.renderer.writeNewline();
      break;
    }
    case 'add': {
      if (!type || !text) {
        ctx.renderer.writeInfo('  Usage: /memory add <type> <text>');
        ctx.renderer.writeInfo('  Types: project, conventions, decisions, errors, history');
        return;
      }
      saveMemory(type, text.slice(0, 60), text);
      ctx.renderer.writeSuccess(`Saved to .mma/memory/${type}.md`);
      break;
    }
    case 'search': {
      if (!type) {
        ctx.renderer.writeInfo('  Usage: /memory search <query>');
        return;
      }
      const results = searchMemory(type);
      if (results.length === 0) {
        ctx.renderer.writeDim('  No matches');
        return;
      }
      ctx.renderer.writeInfo(`  Found ${results.length} matches:`);
      for (const r of results) {
        ctx.renderer.writeLine(`  [${r.type}] ${r.match}`);
      }
      break;
    }
    case 'remove': {
      if (!type) {
        ctx.renderer.writeInfo('  Usage: /memory remove <type> <line-number>');
        ctx.renderer.writeInfo('  First use /memory show <type> to see entries with line numbers.');
        return;
      }
      const lineNum = parseInt(text, 10);
      if (isNaN(lineNum) || lineNum < 1) {
        ctx.renderer.writeDim('  Line number must be a positive integer');
        return;
      }
      const removed = removeMemoryEntry(type, lineNum);
      if (removed) {
        ctx.renderer.writeSuccess(`Entry removed from ${type}.md`);
      } else {
        ctx.renderer.writeError('  Could not remove entry (line number out of range?)');
      }
      break;
    }
    case 'export': {
      const exported = exportMemory();
      if (exported) {
        ctx.renderer.writeSuccess(`Memory exported to ${exported}`);
      } else {
        ctx.renderer.writeDim('  No memory to export');
      }
      break;
    }
    default: {
      ctx.renderer.writeInfo('  Usage: /memory [show <type>|add <type> <text>|search <query>|remove <type> <line>|export]');
    }
  }
}

function cmdSkill(args: string, ctx: CommandContext): void {
  const subcmd = args.trim() || 'list';
  switch (subcmd) {
    case 'list': {
      const skills = listInstalledSkills();
      if (skills.length === 0) {
        ctx.renderer.writeDim('  No skills installed.');
        ctx.renderer.writeDim('  Skills are loaded from: ~/.mma/skills/, ~/.claude/skills/, .claude/skills/, .agents/skills/');
        ctx.renderer.writeDim('  Reference skills in prompts with @skill-name');
      } else {
        ctx.renderer.writeInfo(`  Installed skills (${skills.length}):`);
        for (const s of skills) {
          ctx.renderer.writeLine(`    @${s}`);
        }
      }
      break;
    }
    default:
      ctx.renderer.writeInfo('  Usage: /skill [list]');
  }
}

function cmdSessions(_args: string, ctx: CommandContext): void {
  const sessions = listSessions();
  ctx.renderer.writeLine(formatSessionList(sessions));
}

async function cmdResume(args: string, ctx: CommandContext): Promise<void> {
  if (!args.trim()) {
    ctx.renderer.writeInfo('  Usage: /resume <session-id>');
    ctx.renderer.writeInfo('  Use /sessions to see available sessions.');
    return;
  }
  const session = loadSession(args.trim());
  if (!session) {
    ctx.renderer.writeError(`  Session "${args.trim()}" not found.`);
    return;
  }
  ctx.renderer.writeInfo(`Resumed session: ${session.id} (${session.messages.length} messages)`);
  ctx.renderer.writeDim(`Provider: ${session.provider}`);
  ctx.renderer.writeNewline();
  const lastUser = session.messages.filter(m => m.role === 'user').pop();
  const prevMsgs = session.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role as 'user' | 'assistant' | 'tool', content: m.content }));
  if (lastUser) {
    const result = await runAgentLoop(ctx.provider, ctx.registry, lastUser.content, undefined, prevMsgs, ctx.renderer);
    for (const msg of result.messages) {
      if (msg.role !== 'system') {
        ctx.history.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      }
    }
  }
}

function cmdSave(args: string, ctx: CommandContext): void {
  if (ctx.history.length === 0) {
    ctx.renderer.writeDim('  No conversation to save.');
    return;
  }
  const name = args.trim() || '';
  const providerLabel = `${ctx.provider.model}`;
  const filePath = createNamedSession(name, ctx.history, providerLabel, process.cwd(), { totalTokens: 0, compactCount: 0 });
  const id = filePath.split(/[/\\]/).pop()?.replace('.json', '') || '';
  ctx.renderer.writeSuccess(`Session saved: ${id}${name ? ` (${name})` : ''}`);
}

function cmdClear(_args: string, ctx: CommandContext): void {
  ctx.history.length = 0;
  ctx.renderer.writeInfo('  Context cleared. Starting new session.');
}

function cmdStop(_args: string, ctx: CommandContext): void {
  ctx.renderer.writeDim('  Stopping agent loop...');
  ctx.renderer.destroy();
}

function cmdIndex(args: string, ctx: CommandContext): void {
  const subcmd = args.trim() || 'status';
  switch (subcmd) {
    case 'rebuild': {
      ctx.renderer.writeInfo('  Rebuilding code index...');
      const { formatted } = rebuildCodeIndex(process.cwd());
      ctx.renderer.writeLine(formatted);
      ctx.renderer.writeSuccess('Code index rebuilt');
      break;
    }
    case 'map': {
      ctx.renderer.writeInfo('  Rebuilding project map...');
      const { formatted } = rebuildProjectMap(process.cwd());
      ctx.renderer.writeLine(formatted);
      ctx.renderer.writeSuccess('Project map rebuilt');
      break;
    }
    case 'status': {
      const { formatted: mapFormatted } = getOrBuildProjectMap(process.cwd());
      const { formatted: idxFormatted } = getOrBuildCodeIndex(process.cwd());
      ctx.renderer.writeLine(mapFormatted.split('\n').slice(0, 3).join('\n'));
      ctx.renderer.writeNewline();
      ctx.renderer.writeLine(idxFormatted.split('\n').slice(0, 3).join('\n'));
      break;
    }
    default:
      ctx.renderer.writeInfo('  Usage: /index [status|rebuild|map]');
  }
}

function cmdExport(args: string, ctx: CommandContext): void {
  const mode = args.trim() || 'normal';
  const history = ctx.conversationHistory;
  if (history.length === 0) {
    ctx.renderer.writeDim('  No conversation to export.');
    return;
  }

  let output = '';
  if (mode === 'debug') {
    output = `# Session Debug Export\n`;
    output += `Model: ${ctx.modelLabel}\n`;
    output += `Messages: ${history.length}\n`;
    output += `---\n\n`;
    for (const msg of history) {
      const role = msg.role === 'user' ? '## User' : '## Assistant';
      output += `${role}\n\`\`\`\n${msg.content}\n\`\`\`\n\n`;
    }
  } else {
    output = `# Session Export\n`;
    output += `Model: ${ctx.modelLabel}\n\n`;
    for (const msg of history) {
      const role = msg.role === 'user' ? '**You:**' : '**Assistant:**';
      output += `${role} ${msg.content}\n\n`;
    }
  }

  const filename = `.mma/export-${Date.now()}.md`;
  writeFileSync(filename, output, 'utf-8');
  ctx.renderer.writeSuccess(`  Exported to ${filename}`);
}
