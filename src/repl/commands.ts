import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { globSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { executeBash } from '../tools/bash.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import { runAgentLoop } from '../agent/loop.js';
import { loadMemory, saveMemory, searchMemory, loadAllMemory, ensureMemoryDir, removeMemoryEntry, exportMemory } from '../agent/memory.js';
import { loadProfile, profileExists, appendNote } from '../agent/user-profile.js';
import { listInstalledSkills, listSkillsBySource } from '../skills/loader.js';
import { listSessions, loadSession, createNamedSession, createAutoSession, formatSessionList } from '../session/store.js';
import { rebuildCodeIndex, rebuildProjectMap, getOrBuildCodeIndex, getOrBuildProjectMap } from '../indexer/cache.js';
import { getTheme, listThemes, switchTheme, ThemeEngine } from '../styling/index.js';
import { loadThemeConfig, installTheme, removeTheme } from '../styling/loader.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { logInfo } from '../logger.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { PluginManager } from '../plugins/manager.js';
import { loadAllPluginsWithInfo } from '../plugins/loader.js';

/**
 * Слэш-команды REPL.
 *
 * Все команды, доступные пользователю через префикс /:
 * - Навигация: exit, quit, help, clear, new, stop
 * - Файлы: read, write, edit, find, search
 * - Git: git
 * - Агент: memory, skill, tools, sessions, resume, save
 * - Проект: init, index
 * - UI: theme, profile, mode
 * - Экспорт: export
 *
 * @module repl/commands
 */

type SlashHandler = (args: string, context: CommandContext) => Promise<void> | void;

/** Контекст для выполнения слэш-команд */
export interface CommandContext {
  renderer: OutputRenderer;
  provider: LLMProvider;
  registry: ToolRegistry;
  history: { role: 'user' | 'assistant'; content: string }[];
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
  modelLabel: string;
  currentMode?: string;
  sessionId?: string;
}

/** Определение слэш-команды */
export interface SlashCommand {
  name: string;
  description: string;
  handler: SlashHandler;
}

/** Возвращает список всех доступных слэш-команд */
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
    { name: 'plugins', description: 'list plugins', handler: cmdPlugins },
    { name: 'sessions', description: 'list sessions', handler: cmdSessions },
    { name: 'resume', description: 'resume session', handler: cmdResume },
    { name: 'save', description: 'save session', handler: cmdSave },
    { name: 'clear', description: 'clear screen (visual only)', handler: cmdClear },
    { name: 'new', description: 'reset session (clear context)', handler: cmdNew },
    { name: 'stop', description: 'stop agent loop', handler: cmdStop },
    { name: 'init', description: 'initialize project & create AGENTS.md', handler: cmdInit },
    { name: 'index', description: 'index management', handler: cmdIndex },
    { name: 'theme', description: 'theme management (list/switch/show/install/create/remove)', handler: cmdTheme },
    { name: 'profile', description: 'show/edit user profile', handler: cmdProfile },
    { name: 'tools', description: 'list available agent tools', handler: cmdTools },
    { name: 'export', description: 'export session (normal or debug)', handler: cmdExport },
  ];
}

/** Парсит строку ввода на слэш-команду и аргументы */
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

type HelpEntry = { cmd: string; desc: string };

function formatHelpCmd(theme: ThemeEngine, cmd: string): string {
  const parts = cmd.split(/\s+/);
  const cmdName = parts[0];
  const rest = parts.slice(1).join(' ');
  const styled = cmdName.startsWith('/') ? theme.toolName(cmdName) : theme.toolName(cmdName);
  if (!rest) return styled;
  return `${styled} ${theme.dim(rest)}`;
}

function cmdHelp(_args: string, ctx: CommandContext): void {
  const theme = getTheme();
  const msgCount = ctx.conversationHistory.length;
  const cwd = process.cwd();

  ctx.renderer.writeDim(`  ── session info ──`);
  if (ctx.sessionId) {
    ctx.renderer.writeDim(`  session:   ${ctx.sessionId}`);
  }
  ctx.renderer.writeDim(`  model:     ${ctx.modelLabel}`);
  ctx.renderer.writeDim(`  mode:      ${ctx.currentMode || 'base'}`);
  ctx.renderer.writeDim(`  messages:  ${msgCount}`);
  ctx.renderer.writeDim(`  cwd:       ${cwd}`);
  ctx.renderer.writeNewline();

  const slashHelp: HelpEntry[] = [
    { cmd: '/bash <cmd>', desc: 'run shell command' },
    { cmd: '/read <file>', desc: 'display file with line numbers' },
    { cmd: '/edit <file> <n>', desc: "replace line N in file with rest of args" },
    { cmd: '/write <file>', desc: 'write file (end with EOF on its own line)' },
    { cmd: '/find <pattern>', desc: 'find files by glob pattern' },
    { cmd: '/search <pattern>', desc: 'search file contents' },
    { cmd: '/git <args>', desc: 'git operations' },
    { cmd: '/memory', desc: 'memory management (show/add/search/remove/export)' },
    { cmd: '/skill', desc: 'list installed skills' },
    { cmd: '/plugins', desc: 'list plugins' },
    { cmd: '/tools', desc: 'list agent tools' },
    { cmd: '/sessions', desc: 'list saved sessions' },
    { cmd: '/resume <id>', desc: 'resume a session' },
    { cmd: '/save [name]', desc: 'save current session' },
    { cmd: '/clear', desc: 'clear screen (visual only)' },
    { cmd: '/new', desc: 'reset session (clear history)' },
    { cmd: '/export [mode]', desc: 'export session (normal or debug)' },
    { cmd: '/init', desc: 'analyze project & create AGENTS.md' },
    { cmd: '/index [cmd]', desc: 'index status/show/map/rebuild' },
    { cmd: '/profile [note]', desc: 'show profile or add note' },
    { cmd: '/profile name <n>', desc: 'save your name' },
    { cmd: '/profile show', desc: 'show profile content' },
    { cmd: '/mode fast|base|pro', desc: 'switch agent mode' },
    { cmd: '/stop', desc: 'stop agent loop' },
    { cmd: '/exit', desc: 'exit MMA' },
  ];

  ctx.renderer.writeLine(`  ${theme.highlight('/ commands')}`);
  for (const entry of slashHelp) {
    ctx.renderer.writeLine(`  ${formatHelpCmd(theme, entry.cmd)} ${theme.dim(`— ${entry.desc}`)}`);
  }

  ctx.renderer.writeNewline();

  const cliHelp: HelpEntry[] = [
    { cmd: 'mma provider list', desc: 'list providers' },
    { cmd: 'mma provider add <name> <url>', desc: 'add provider (Ollama, vLLM, Together...)' },
    { cmd: 'mma provider use <name>', desc: 'switch active provider' },
    { cmd: 'mma provider remove <name>', desc: 'remove provider' },
    { cmd: 'mma model list', desc: 'list models' },
    { cmd: 'mma model add <name> <id> <ctx>', desc: 'add model (e.g. qwen3.5-9b ... 32768)' },
    { cmd: 'mma model use <name>', desc: 'switch active model' },
    { cmd: 'mma model params [name]', desc: 'show model parameters' },
    { cmd: 'mma model set <name> k=v', desc: 'change parameter (temperature=0.3)' },
    { cmd: 'mma config show', desc: 'show full configuration' },
    { cmd: 'mma config reset', desc: 'reset to defaults' },
    { cmd: 'mma update', desc: 'check for updates' },
    { cmd: 'mma update install', desc: 'install latest version' },
  ];

  ctx.renderer.writeLine(`  ${theme.highlight('CLI commands')} ${theme.dim('(exit REPL, then run)')}`);
  for (const entry of cliHelp) {
    ctx.renderer.writeLine(`  ${formatHelpCmd(theme, entry.cmd)} ${theme.dim(`— ${entry.desc}`)}`);
  }
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
    const allLines = result.trim().split('\n');
    const lines = allLines.slice(0, 30);
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      ctx.renderer.writeDim('  No matches');
      return;
    }
    const theme = getTheme();
    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):(.*)/);
      if (match) {
        ctx.renderer.writeLine(`  ${theme.filePath(match[1])}${theme.dim(':')}${theme.lineNumbers(match[2])}${theme.dim(':')}${match[3]}`);
      } else {
        ctx.renderer.writeLine(`${theme.indent}${line}`);
      }
    }
    if (allLines.length > 30) {
      ctx.renderer.writeDim(`  ... (${allLines.length - 30} more)`);
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
      ctx.renderer.writeSuccess(`Saved to ${theme.filePath(`.mma/memory/${type}.md`)}`);
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
        ctx.renderer.writeLine(`  ${theme.highlight(`[${r.type}]`)} ${theme.dim(r.match)}`);
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
        ctx.renderer.writeSuccess(`Entry removed from ${theme.filePath(`${type}.md`)}`);
      } else {
        ctx.renderer.writeError('  Could not remove entry (line number out of range?)');
      }
      break;
    }
    case 'export': {
      const exported = exportMemory();
      if (exported) {
        ctx.renderer.writeSuccess(`Memory exported to ${theme.filePath(exported)}`);
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
  const theme = getTheme();
  switch (subcmd) {
    case 'list': {
      const bySource = listSkillsBySource(process.cwd());
      const total = bySource.builtin.length + bySource.project.length + bySource.global.length;
      if (total === 0) {
        ctx.renderer.writeDim('  No skills available.');
        ctx.renderer.writeDim('  Place skills in .claude/skills/<name>/SKILL.md or install via npm.');
        return;
      }
      ctx.renderer.writeInfo(`  Skills (${total} total):`);
      if (bySource.builtin.length > 0) {
        ctx.renderer.writeLine(`    ${theme.info('built-in:')}`);
        for (const s of bySource.builtin) ctx.renderer.writeLine(`      ${theme.toolName(`@${s}`)}`);
      }
      if (bySource.project.length > 0) {
        ctx.renderer.writeLine(`    ${theme.info('project:')}`);
        for (const s of bySource.project) ctx.renderer.writeLine(`      ${theme.toolName(`@${s}`)}`);
      }
      if (bySource.global.length > 0) {
        ctx.renderer.writeLine(`    ${theme.info('global:')}`);
        for (const s of bySource.global) ctx.renderer.writeLine(`      ${theme.toolName(`@${s}`)}`);
      }
      ctx.renderer.writeDim(`  ${theme.dim('Reference:')} ${theme.symbolName('@skill-name')}`);
      break;
    }
    default:
      ctx.renderer.writeInfo('  Usage: /skill [list]');
  }
}

async function cmdPlugins(_args: string, ctx: CommandContext): Promise<void> {
  const pluginManager = new PluginManager();
  await loadAllPluginsWithInfo(pluginManager);
  const plugins = pluginManager.listPlugins();
  const theme = getTheme();

  if (plugins.length === 0) {
    ctx.renderer.writeDim('  No plugins available.');
    ctx.renderer.writeDim('  Place plugins in .mma/plugins/<name>/');
    return;
  }

  ctx.renderer.writeInfo(`  Available plugins (${plugins.length}):`);
  for (const p of plugins) {
    const version = p.version ? ` ${theme.dim(`v${p.version}`)}` : '';
    const source = theme.dim(`[${p.source}]`);
    const status = p.active ? theme.success('active') : theme.dim('inactive');
    ctx.renderer.writeLine(`    ${theme.highlight(p.name)}${version}  ${source}  ${status}`);
  }
}

function cmdTools(_args: string, ctx: CommandContext): void {
  const defs = ctx.registry.getDefinitions();
  const theme = getTheme();

  const categories: Record<string, { names: Set<string>; color: (s: string) => string }> = {
    native: { names: new Set(['subagent', 'scaffold', 'project_map']), color: (s) => theme.toolName(s) },
    bash: { names: new Set(['bash']), color: (s) => theme.symbolName(s) },
    fs: { names: new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir', 'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search', 'grep_search', 'tree']), color: (s) => theme.filePath(s) },
    web: { names: new Set(['web_search', 'web_fetch', 'web_browse']), color: (s) => theme.link(s) },
  };

  const categoryMeta = [
    { key: 'native', label: 'native' },
    { key: 'bash',   label: 'exec' },
    { key: 'fs',     label: 'files' },
    { key: 'web',    label: 'web' },
  ];

  ctx.renderer.writeNewline();
  ctx.renderer.writeInfo(`  tools (${defs.length}):`);

  for (const meta of categoryMeta) {
    const cat = categories[meta.key];
    const items = defs.filter(d => cat.names.has(d.function.name));
    if (items.length === 0) continue;

    ctx.renderer.writeLine(`  ${theme.dim(meta.label + ':')}`);
    for (const d of items) {
      const desc = d.function.description.split('\n')[0];
      const shortDesc = desc.length > 55 ? desc.slice(0, 52) + '…' : desc;
      ctx.renderer.writeLine(`    ${cat.color(d.function.name)} ${theme.dim('—')} ${theme.dim(shortDesc)}`);
    }
  }

  ctx.renderer.writeNewline();
  ctx.renderer.writeLine(theme.dim(`  details: /help`));
}

function cmdSessions(_args: string, ctx: CommandContext): void {
  const sessions = listSessions();
  ctx.renderer.writeLine(formatSessionList(sessions));
}

async function cmdResume(args: string, ctx: CommandContext): Promise<void> {
  const theme = getTheme();
  if (!args.trim()) {
    ctx.renderer.writeInfo('  Usage: /resume <session-id>');
    ctx.renderer.writeInfo('  Use /sessions to see available sessions.');
    return;
  }
  const session = loadSession(args.trim());
  if (!session) {
    ctx.renderer.writeError(`  Session ${theme.highlight(args.trim())} not found.`);
    return;
  }

  ctx.renderer.clear();
  ctx.renderer.writeInfo(`  Resumed session: ${theme.highlight(session.id)} (${session.messages.length} messages)`);
  ctx.renderer.writeDim(`  Provider: ${session.provider}`);
  ctx.renderer.writeNewline();

  // Display previous conversation and rebuild history
  ctx.history.length = 0;
  const displayMsgs = session.messages.filter(m => m.role !== 'system');
  for (const msg of displayMsgs) {
    ctx.renderer.writeNewline();
    ctx.renderer.writeDim('─'.repeat(40));
    const tag = msg.role === 'user' ? 'user' : 'assistant';
    ctx.renderer.writeBracketTag(tag, ` ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '…' : ''}`);
    if (msg.content.length > 200) {
      ctx.renderer.writeDim('  (message truncated, full content loaded)');
    }
    ctx.renderer.writeDim('─'.repeat(40));
    ctx.renderer.writeNewline();
    ctx.history.push({ role: msg.role === 'tool' ? 'assistant' : msg.role as 'user' | 'assistant', content: msg.content });
  }

  const lastUser = [...displayMsgs].reverse().find(m => m.role === 'user');
  if (lastUser) {
    // Feed history WITHOUT the last user message to avoid duplication
    const prevMsgs = ctx.history.filter(m => m.content !== lastUser.content || m.role !== 'user');
    const result = await runAgentLoop(ctx.provider, ctx.registry, lastUser.content, undefined, prevMsgs, ctx.renderer);
    for (const msg of result.messages) {
      if (msg.role !== 'system') {
        const dup = ctx.history.find(m => m.content === msg.content && m.role === msg.role);
        if (!dup) ctx.history.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
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
  const theme = getTheme();
  ctx.renderer.writeSuccess(`Session saved: ${theme.highlight(id)}${name ? ` (${theme.dim(name)})` : ''}`);
}

function cmdClear(_args: string, ctx: CommandContext): void {
  ctx.renderer.clear();
}

function cmdNew(_args: string, ctx: CommandContext): void {
  ctx.history.length = 0;
  ctx.renderer.clear();
  ctx.renderer.writeInfo('  Context cleared. Starting new session.');
}

function cmdStop(_args: string, ctx: CommandContext): void {
  ctx.renderer.writeDim('  Stopping agent loop...');
  ctx.renderer.destroy();
}

const AUTO_HEADERS = new Set([
  '## Description', '## Git', '## Tech Stack',
  '## Key Dependencies', '## Commands',
  '## Conventions', '## Project Structure',
]);

export function stripAutoSections(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let skip = false;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) skip = AUTO_HEADERS.has(`## ${m[1]}`);
    if (!skip) result.push(line);
  }
  return result.join('\n').trim();
}

export function getGitInfo(): { remote: string; branch: string; lastCommit: string } | null {
  try {
    const remote = execSync('git config --get remote.origin.url', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const lastCommit = execSync('git log --oneline -1', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    return { remote, branch, lastCommit };
  } catch {
    return null;
  }
}

function cmdInit(_args: string, ctx: CommandContext): void {
  const theme = getTheme();
  const cwd = process.cwd();
  ctx.renderer.writeNewline();
  ctx.renderer.writeInfo('  Analyzing project...');

  const agentsPath = join(cwd, 'AGENTS.md');
  const existed = existsSync(agentsPath);

  // Read existing AGENTS.md first to preserve custom sections
  let preservedContent = '';
  if (existed) {
    const existingContent = readFileSync(agentsPath, 'utf-8');
    preservedContent = stripAutoSections(existingContent);
  }

  // Scan project
  const projectName = basename(cwd);
  let description = '';
  let scripts: Record<string, string> = {};
  let deps: string[] = [];
  let devDeps: string[] = [];

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      description = pkg.description || '';
      scripts = pkg.scripts || {};
      deps = Object.keys(pkg.dependencies || {});
      devDeps = Object.keys(pkg.devDependencies || {});
    } catch { /* ignore */ }
  }

  const langCounts: Record<string, number> = {};
  const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'php', 'c', 'cpp', 'h', 'css', 'scss', 'html', 'vue', 'svelte', 'prisma'];
  try { walkDirForLangs(cwd, exts, langCounts); } catch { /* ignore */ }

  const mainLang = Object.entries(langCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);

  let stack = '';
  if (existsSync(join(cwd, 'tsconfig.json'))) stack += 'TypeScript, ';
  if (existsSync(join(cwd, 'next.config.js')) || existsSync(join(cwd, 'next.config.mjs'))) stack += 'Next.js, ';
  if (existsSync(join(cwd, 'astro.config.mjs'))) stack += 'Astro, ';
  if (existsSync(join(cwd, 'vite.config.ts')) || existsSync(join(cwd, 'vite.config.js'))) stack += 'Vite, ';
  if (existsSync(join(cwd, 'vitest.config.ts')) || existsSync(join(cwd, 'vitest.config.js'))) stack += 'Vitest, ';
  if (existsSync(join(cwd, 'jest.config.js')) || existsSync(join(cwd, 'jest.config.ts'))) stack += 'Jest, ';
  if (existsSync(join(cwd, '.eslintrc.js')) || existsSync(join(cwd, 'eslint.config.js'))) stack += 'ESLint, ';
  if (existsSync(join(cwd, 'prisma/schema.prisma'))) stack += 'Prisma, ';
  if (existsSync(join(cwd, 'Dockerfile'))) stack += 'Docker, ';
  if (existsSync(join(cwd, 'docker-compose.yml'))) stack += 'Docker Compose, ';
  if (existsSync(join(cwd, '.github/workflows'))) stack += 'GitHub Actions, ';

  const buildCmd = scripts.build || scripts.compile || '';
  const testCmd = scripts.test || '';
  const devCmd = scripts.dev || scripts.start || scripts['dev:watch'] || '';

  let agentsContent = `# ${projectName}\n\n`;
  agentsContent += `LLM agent instructions for the project \`${projectName}\`.\n\n`;

  if (description) {
    agentsContent += `## Description\n\n${description}\n\n`;
  }

  // Git info
  const gitInfo = getGitInfo();
  if (gitInfo) {
    agentsContent += '## Git\n\n';
    agentsContent += `- **Remote**: ${gitInfo.remote}\n`;
    agentsContent += `- **Branch**: ${gitInfo.branch}\n`;
    agentsContent += `- **Last commit**: ${gitInfo.lastCommit}\n\n`;
  }

  if (stack || mainLang.length > 0) {
    agentsContent += '## Tech Stack\n\n';
    if (stack) agentsContent += `- **Framework/Tools**: ${stack.replace(/, $/, '')}\n`;
    for (const [lang, count] of mainLang) {
      agentsContent += `- **${lang.toUpperCase()}**: ${count} files\n`;
    }
    agentsContent += '\n';
  }

  if (deps.length > 0 || devDeps.length > 0) {
    agentsContent += '## Key Dependencies\n\n';
    if (deps.length > 0) {
      const core = deps.filter(d => !d.startsWith('@types/')).slice(0, 10);
      agentsContent += `- Runtime: ${core.join(', ')}\n`;
    }
    if (devDeps.length > 0) {
      const tools = devDeps.filter(d => !d.startsWith('@types/')).slice(0, 10);
      agentsContent += `- Dev: ${tools.join(', ')}\n`;
    }
    agentsContent += '\n';
  }

  if (buildCmd || testCmd || devCmd) {
    agentsContent += '## Commands\n\n';
    if (buildCmd) agentsContent += `\`\`\`bash\n# build\nnpm run build\n\`\`\`\n\n`;
    if (testCmd) agentsContent += `\`\`\`bash\n# test\nnpm test\n\`\`\`\n\n`;
    if (devCmd) agentsContent += `\`\`\`bash\n# dev\nnpm run dev\n\`\`\`\n\n`;
  }

  agentsContent += `## Conventions\n\n`;
  agentsContent += `- Use \`<tool_call>\` JSON format for tool invocation\n`;
  agentsContent += `- Use filesystem tools for file operations, bash for npm/git only\n`;
  if (existsSync(join(cwd, '.gitignore'))) {
    try {
      const gitignore = readFileSync(join(cwd, '.gitignore'), 'utf-8');
      const ignores = gitignore.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 10);
      if (ignores.length > 0) {
        agentsContent += `- Ignored paths: \`${ignores.join('`, `')}\`\n`;
      }
    } catch { /* ignore */ }
  }
  agentsContent += '\n';

  agentsContent += `## Project Structure\n\n`;
  try {
    const top = readdirSync(cwd, { withFileTypes: true })
      .filter(f => !f.name.startsWith('.') && f.name !== 'node_modules' && f.name !== 'dist')
      .slice(0, 20);
    agentsContent += '```\n';
    for (const f of top) {
      agentsContent += f.isDirectory() ? `${f.name}/\n` : `${f.name}\n`;
    }
    agentsContent += '```\n\n';
  } catch { /* ignore */ }

  // Append preserved custom sections from existing AGENTS.md
  if (preservedContent) {
    agentsContent += preservedContent + '\n\n';
  }

  try {
    writeFileSync(agentsPath, agentsContent, 'utf-8');
    const verb = existed ? 'Updated' : 'Created';
    ctx.renderer.writeSuccess(`  ${verb} ${theme.filePath('AGENTS.md')}`);
    ctx.renderer.writeNewline();
    ctx.renderer.writeLine(agentsContent);
    logInfo('REPL', `AGENTS.md ${verb.toLowerCase()}d: ${agentsPath}`);
  } catch (e: any) {
    ctx.renderer.writeError(`  Failed to write AGENTS.md: ${e.message}`);
  }
}

function walkDirForLangs(dir: string, exts: string[], counts: Record<string, number>): void {
  const IGNORE = new Set(['node_modules', '.git', '.mma', 'dist', 'build', '__pycache__', 'target', '.next', '.nuxt', 'coverage', '.cache', 'venv', '.venv', 'env']);
  let entries: any[];
  try { entries = readdirSync(dir, { withFileTypes: true }) as any; } catch { return; }
  for (const entry of entries) {
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDirForLangs(fullPath, exts, counts);
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() || '';
      if (exts.includes(ext)) {
        counts[ext] = (counts[ext] || 0) + 1;
      }
    }
  }
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
    case 'show': {
      const { formatted, fromCache } = getOrBuildProjectMap(process.cwd());
      ctx.renderer.writeLine(formatted);
      if (fromCache) {
        ctx.renderer.writeDim('  (from cache)');
      }
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
      ctx.renderer.writeInfo('  Usage: /index [status|show|map|rebuild]');
  }
}

function cmdProfile(args: string, ctx: CommandContext): void {
  const theme = getTheme();
  if (!args.trim()) {
    const content = loadProfile();
    if (content) {
      ctx.renderer.writeNewline();
      ctx.renderer.writeLine(content);
      ctx.renderer.writeNewline();
    } else {
      ctx.renderer.writeDim('  User profile is empty.');
      ctx.renderer.writeDim('  It will be auto-populated as you work.');
    }
    return;
  }

  const parts = args.trim().split(/\s+/);
  const subcmd = parts[0];
  const rest = parts.slice(1).join(' ');

  if (subcmd === 'name' && rest) {
    appendNote(`Имя пользователя: ${rest}`, 'Notes');
    ctx.renderer.writeSuccess(`  Name saved: ${theme.highlight(rest)}`);
    return;
  }

  if (subcmd === 'show') {
    const content = loadProfile();
    if (content) {
      ctx.renderer.writeNewline();
      ctx.renderer.writeLine(content);
      ctx.renderer.writeNewline();
    } else {
      ctx.renderer.writeDim('  Profile is empty.');
    }
    return;
  }

  appendNote(args.trim(), 'Notes');
  ctx.renderer.writeSuccess('Note added to user profile.');
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
  mkdirSync('.mma', { recursive: true });
  writeFileSync(filename, output, 'utf-8');
  const theme = getTheme();
  ctx.renderer.writeSuccess(`  Exported to ${theme.filePath(filename)}`);
}

async function cmdTheme(args: string, ctx: CommandContext): Promise<void> {
  const theme = getTheme();
  const parts = args.trim().split(/\s+/);
  const subcmd = parts[0] || 'list';
  const name = parts.slice(1).join(' ');

  switch (subcmd) {
    case 'list': {
      const allThemes = listThemes();
      const current = loadThemeConfig().name;
      ctx.renderer.writeInfo(`  Available themes (${allThemes.length}):`);
      for (const t of allThemes) {
        const marker = t === current ? theme.success(' ← active') : '';
        ctx.renderer.writeLine(`    ${theme.highlight(t)}${marker}`);
      }
      break;
    }
    case 'show': {
      const config = loadThemeConfig();
      ctx.renderer.writeInfo(`  Current theme: ${theme.highlight(config.name)}`);
      ctx.renderer.writeLine(`    ${theme.dim('Colors:')} ${theme.highlight(String(Object.keys(config.colors).length))} keys`);
      ctx.renderer.writeLine(`    ${theme.dim('Icons:')} ${theme.highlight(String(Object.keys(config.icons).length))} keys`);
      break;
    }
    case 'create': {
      if (!name) { ctx.renderer.writeInfo('  Usage: /theme create <name>'); break; }
      const current = loadThemeConfig();
      current.name = name;
      const filePath = installTheme(name, JSON.stringify(current, null, 2));
      ctx.renderer.writeSuccess(`  Theme ${theme.highlight(name)} created (${theme.filePath(filePath)})`);
      break;
    }
    case 'install': {
      const [themeName, url] = parts.slice(1);
      if (!themeName || !url) { ctx.renderer.writeInfo('  Usage: /theme install <name> <url>'); break; }
      ctx.renderer.writeDim(`  Downloading from ${theme.link(url)}...`);
      try {
        const resp = execSync(`curl -s "${url}"`, { encoding: 'utf-8', timeout: 10000, windowsHide: true });
        JSON.parse(resp);
        const filePath = installTheme(themeName, resp);
        ctx.renderer.writeSuccess(`  Theme ${theme.highlight(themeName)} installed (${theme.filePath(filePath)})`);
      } catch (e: any) {
        ctx.renderer.writeError(`  Failed to install: ${e.message}`);
      }
      break;
    }
    case 'remove': {
      if (!name) { ctx.renderer.writeInfo('  Usage: /theme remove <name>'); break; }
      if (!removeTheme(name)) { ctx.renderer.writeError(`  Theme ${theme.highlight(name)} not found`); break; }
      ctx.renderer.writeSuccess(`  Theme ${theme.highlight(name)} removed`);
      break;
    }
    default: {
      const allThemes = listThemes();
      if (!allThemes.includes(subcmd)) { ctx.renderer.writeError(`  Unknown theme ${theme.highlight(subcmd)}. Use /theme list`); break; }
      const config = loadConfig();
      config.theme = subcmd;
      saveConfig(config);
      switchTheme(subcmd);
      try {
        const { resetInkTheme } = await import('../ui/ink/theme.js');
        resetInkTheme();
      } catch { /* not in ink mode */ }
      ctx.renderer.writeSuccess(`  Theme switched to "${subcmd}"`);
      break;
    }
  }
}
