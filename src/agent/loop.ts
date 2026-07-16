import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as os from 'node:os';
import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { loadAllMemory, loadAllMemoryDetailed, autoLearnFromError } from './memory.js';
import { getOrBuildProjectMap } from '../indexer/cache.js';
import { loadAgentsMd, loadSkillsFromRefs, formatSkillsBlock } from '../skills/loader.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { isMCPCommand, parseMCPCommand, callMCPTool } from '../tools/mcp.js';
import { createPlan, updatePlanStep, showPlan, clearPlan, parsePlanCommand } from '../tools/plan.js';
import { addTodo, doneTodo, removeTodo, listTodos, parseTodoCommand } from '../tools/todo.js';
import { askQuestion, parseQuestionCommand } from '../tools/question.js';
import { parseApproveCommand } from '../tools/approve.js';
import { getTheme } from '../styling/index.js';

const TOOL_FORMAT = `Available tools:

1. bash — Execute shell commands. Use for ALL operations: read/write files, git, npm, etc.
   To call it, output EXACTLY this format (on its own line):
   <tool_call>{"name":"bash","arguments":{"cmd":"your command here"}}</tool_call>

2. plan — Manage project plans for complex tasks.
   To call it, output EXACTLY this format (on its own line):
   <tool_call>{"name":"bash","arguments":{"cmd":"plan create MyProject Step1 Step2 Step3"}}</tool_call>
   Commands:
    plan create <name> <step1> <step2> ... — Create a new plan
    plan show — Show current plan
    plan done <stepId> — Mark step as done
    plan progress <stepId> — Mark step as in progress
    plan clear — Clear current plan

3. todo — Track task progress.
   To call it, output EXACTLY this format (on its own line):
   <tool_call>{"name":"bash","arguments":{"cmd":"todo add Create index.ts"}}</tool_call>
   Commands:
    todo add <text> — Add a new task
    todo done <id|text> — Mark task as done
    todo remove <id|text> — Remove task
    todo list — Show all tasks with progress

4. question — Ask the user a question before proceeding.
   To call it, output EXACTLY this format (on its own line):
   <tool_call>{"name":"bash","arguments":{"cmd":"question What framework? | Express | Fastify | Hapi"}}</tool_call>
   Use when:
   - You need to clarify requirements before starting
   - You need to choose between multiple options
   - You need user input to continue

5. approve — Request confirmation before risky actions.
   To call it, output EXACTLY this format (on its own line):
   <tool_call>{"name":"bash","arguments":{"cmd":"approve Delete all files in dist/"}}</tool_call>
   Use before:
   - Deleting files or directories
   - Overwriting existing files
   - Running destructive commands
   - Any action that cannot be easily undone`;

const RULES_COMMON = `Rules:
1. Use bash for EVERYTHING — ALWAYS use <tool_call> for file ops, never write content as chat text.
2. Always respond in the user's language (Русский или English).
3. CRITICAL: After every tool call, CHECK the result (exit code + output).
   If exit code != 0, DO NOT claim success — tell the user about the error.
   Verify files were created before saying "done".
4. The JSON inside <tool_call> must be VALID JSON. Escape " inside values as \\\".
   If your command contains double quotes, wrap them in escaped form.`;

const POWERSHELL_EXAMPLES = `Examples (PowerShell):
  <tool_call>{"name":"bash","arguments":{"cmd":"dir"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"Get-Content src\\\\index.ts"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"npm test"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"Set-Content -Path file.md -Value 'Hello World'"}}</tool_call>`;

const POWERSHELL_RULES = `PowerShell specifics:
- Create/write files: Set-Content -Path file.md -Value "content"
- Append to file: Add-Content -Path file.md -Value "line"
- Read files: Get-Content file.md
- List directory: dir (or Get-ChildItem)
- Create directories: New-Item -ItemType Directory -Force -Path "folder"
- NEVER use: echo -e, cat (use Get-Content), bash syntax like mkdir -p or {src/routes,...}
- NEVER use single quotes for strings with \\n, \\t — use DOUBLE quotes: "line1\\nline2"
- Paths use backslashes: src\\index.ts
- Check file exists: Test-Path file.md
- Install deps: npm install (NOT npm i)
- Run dev: npm run dev (NOT npx tsx watch)`;


const UNIX_EXAMPLES = `Examples (Linux/macOS):
  <tool_call>{"name":"bash","arguments":{"cmd":"ls -la"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"cat src/index.ts"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"npm test"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"echo 'Hello World' > file.md"}}</tool_call>`;

const UNIX_RULES = `Unix specifics:
- Create/write files: echo "content" > file.md
- Read files: cat file.md
- List directory: ls -la
- Paths use forward slashes: src/index.ts
- Check file exists: test -f file.md`;

function buildSystemPrompt(): string {
  const isWin = os.platform() === 'win32';
  const platformName = isWin ? 'Windows' : os.platform();
  let osVersion = platformName;
  try { osVersion += ` (${os.version()})`; } catch { /* ignore */ }

  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('ru-RU');

  let projectName = 'unknown';
  const pkgPath = resolve(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    try { projectName = JSON.parse(readFileSync(pkgPath, 'utf-8')).name || 'unknown'; } catch { /* ignore */ }
  }

  const platformBlock = isWin
    ? [TOOL_FORMAT, POWERSHELL_EXAMPLES, RULES_COMMON, POWERSHELL_RULES].join('\n\n')
    : [TOOL_FORMAT, UNIX_EXAMPLES, RULES_COMMON, UNIX_RULES].join('\n\n');

  const header = `You are Micro Models Agent (MMA), an AI coding assistant.
You help with software engineering tasks in the project directory.`;

  const sysInfo = [
    '',
    '## System',
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    `OS: ${osVersion}`,
    `Node.js: ${process.version}`,
    `CWD: ${process.cwd()}`,
    `Project: ${projectName}`,
    '',
  ].join('\n');

  const memory = loadAllMemoryDetailed();

  let projectMap = '';
  try {
    const { formatted, fromCache } = getOrBuildProjectMap(process.cwd());
    if (formatted) {
      projectMap = `\n## Project Map${fromCache ? ' (cached)' : ''}\n${formatted}`;
    }
  } catch { /* ignore */ }

  const agentsMd = loadAgentsMd(process.cwd());
  const agentsBlock = agentsMd ? `\n## Project Instructions (AGENTS.md)\n${agentsMd}` : '';

  return [header, platformBlock, sysInfo, memory, projectMap, agentsBlock].filter(Boolean).join('\n');
}

function extractToolCallJson(response: string): string | null {
  // Stage 1: Find <tool_call> block
  let text = response;
  const tcStart = text.indexOf('<tool_call>');
  const tcEnd = text.indexOf('</tool_call>');
  if (tcStart !== -1) {
    if (tcEnd !== -1) {
      text = text.slice(tcStart + '<tool_call>'.length, tcEnd);
    } else {
      text = text.slice(tcStart + '<tool_call>'.length);
    }
  }

  // Stage 2: Strip markdown code fences
  text = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

  // Stage 3: Find JSON object with brace matching
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return text.slice(jsonStart, i + 1);
  }

  // Stage 4: If no closing brace, take everything from { to end (truncated JSON)
  if (depth > 0 && jsonStart < text.length) {
    return text.slice(jsonStart);
  }

  return null;
}

function extractToolCallFallback(response: string): { name: string; cmd: string } | null {
  // Fallback: regex extraction for "name":"bash","arguments":{"cmd":"..."}
  const patterns = [
    /"name"\s*:\s*"bash"\s*,\s*"arguments"\s*:\s*\{\s*"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /name['"]\s*:\s*['"]bash['"]\s*,.*?cmd['"]\s*:\s*['"]((?:[^'\\]|\\.)*)['"]/,
  ];

  for (const re of patterns) {
    const m = response.match(re);
    if (m) {
      let cmd = m[1];
      // Unescape
      cmd = cmd.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return { name: 'bash', cmd };
    }
  }
  return null;
}

function validateToolCall(parsed: any): { valid: boolean; cmd?: string; error?: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Not an object' };
  }
  if (parsed.name !== 'bash') {
    return { valid: false, error: `Unknown tool: ${parsed.name}` };
  }
  if (!parsed.arguments || typeof parsed.arguments !== 'object') {
    return { valid: false, error: 'Missing arguments' };
  }
  const cmd = String(parsed.arguments.cmd ?? '').trim();
  if (!cmd) {
    return { valid: false, error: 'Empty command' };
  }
  return { valid: true, cmd };
}

const CLEAR_LINE = '\r\x1b[K';

async function doChat(
  provider: LLMProvider,
  messages: ChatMessage[],
  retries = 3,
): Promise<{ response: string; genTimeMs: number }> {
  const theme = getTheme();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;

    process.stdout.write(theme.spinner());

    try {
      let buf = '';
      for await (const chunk of provider.chat(messages, { temperature: 0.7, max_tokens: 8192 })) {
        if (!chunk.content) continue;
        fullText.push(chunk.content);

        if (!started) {
          process.stdout.write(CLEAR_LINE);
          started = true;
        }

        buf += chunk.content;

        while (buf.length > 0) {
          const tcStart = buf.indexOf('<tool_call>');
          const tcEnd = buf.indexOf('</tool_call>');

          if (tcStart === -1 && tcEnd === -1) {
            process.stdout.write(buf);
            buf = '';
            break;
          }

          if (tcStart !== -1 && (tcEnd === -1 || tcStart < tcEnd)) {
            if (tcStart > 0) {
              process.stdout.write(buf.slice(0, tcStart));
            }
            buf = buf.slice(tcStart);
            const closeIdx = buf.indexOf('</tool_call>');
            if (closeIdx !== -1) {
              buf = buf.slice(closeIdx + '</tool_call>'.length);
            }
            break;
          }

          if (tcEnd !== -1 && (tcStart === -1 || tcEnd < tcStart)) {
            process.stdout.write(buf.slice(0, tcEnd));
            buf = buf.slice(tcEnd + '</tool_call>'.length);
          }
        }
      }
    } catch (e: any) {
      console.error(theme.error(`\n[LLM] ${e.message}`));
      console.log(theme.warning('[LLM] Check that your server is running (LM Studio on localhost:1234 or Ollama)'));
      return { response: '', genTimeMs: 0 };
    }

    const genTimeMs = performance.now() - startTime;
    const response = fullText.join('');
    console.log();

    if (response.trim()) {
      console.log(theme.timingLine((genTimeMs / 1000).toFixed(1)));
      return { response, genTimeMs };
    }

    if (attempt < retries) {
      console.log(theme.bracketTag('retry', `${attempt + 1}/${retries}`));
    }
  }

  return { response: '', genTimeMs: 0 };
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  questionPending?: { question: string; choices?: string[] };
}

export async function runAgentLoop(
  provider: LLMProvider,
  registry: ToolRegistry,
  prompt: string,
  contextManager?: ContextManager,
  previousMessages?: ChatMessage[],
): Promise<AgentLoopResult> {
  const theme = getTheme();
  const { prompt: enrichedPrompt, files } = await parseFileRefs(prompt);

  const skills = loadSkillsFromRefs(prompt, process.cwd());
  if (skills.length > 0) {
    console.log(theme.info(`  Loaded ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')} (~${skills.reduce((s, sk) => s + sk.tokens, 0)} tokens)`));
  }

  if (files.length > 0) {
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    console.log(theme.info(`  Loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`));
    console.log();
  }

  const systemPrompt = buildSystemPrompt() + (skills.length > 0 ? '\n\n' + formatSkillsBlock(skills) : '');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(previousMessages || []),
    { role: 'user', content: enrichedPrompt },
  ];

  const ctx = contextManager ?? new ContextManager(provider.contextWindow);

  for (let step = 0; step < 25; step++) {
    await ctx.updateTokens(messages);
    console.log(`  ${ctx.formatUsage()}`);

    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      console.log(theme.bracketTag('compact', `${before} → ${messages.length} messages`));
      await ctx.updateTokens(messages);
    }

    const { response } = await doChat(provider, messages);

    if (!response.trim()) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'tool') {
        messages.push({ role: 'user', content: 'Теперь ответь пользователю на основе результата выше. Не вызывай инструменты — просто напиши ответ.' });
        console.log(theme.dim('  [empty response after tool, retrying with prompt]'));
        continue;
      }
      console.log(theme.error('[model returned empty response]'));
      return { messages };
    }

    messages.push({ role: 'assistant', content: response });

    let parsed: any = null;
    let cmd = '';

    // Stage 1: Try standard JSON extraction
    const jsonRaw = extractToolCallJson(response);
    if (jsonRaw) {
      try {
        parsed = JSON.parse(jsonrepair(jsonRaw));
      } catch {
        // jsonrepair failed, try raw parse
        try { parsed = JSON.parse(jsonRaw); } catch { /* continue to fallback */ }
      }
    }

    // Stage 2: Validate parsed structure
    if (parsed) {
      const v = validateToolCall(parsed);
      if (v.valid) {
        cmd = v.cmd!;
      } else {
        console.log(theme.error(`  [invalid tool call] ${v.error}`));
        // Add error feedback to messages and retry
        messages.push({ role: 'tool', content: `Error: Invalid tool call format. ${v.error}. Use exactly: {"name":"bash","arguments":{"cmd":"your command"}}`, tool_call_id: `err-${step}` });
        continue;
      }
    }

    // Stage 3: Fallback regex extraction
    if (!cmd) {
      const fallback = extractToolCallFallback(response);
      if (fallback) {
        cmd = fallback.cmd;
        parsed = { name: 'bash', arguments: { cmd } };
        console.log(theme.bracketTag('fallback', 'regex extracted command'));
      } else {
        return { messages };
      }
    }

      const cmdPreview = cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd;
      const toolId = `call-${Date.now()}-${step}`;

      console.log();
      console.log(theme.toolHeader('bash'));
      console.log(`  ${theme.dim(cmdPreview)}`);

      const preHook = runPreToolUseHooks(process.cwd(), parsed.name, cmd);
      if (!preHook.continue) {
        console.log(theme.bracketTag('hook blocked', preHook.message || ''));
        messages.push({ role: 'tool', content: `Hook blocked: ${preHook.message || ''}`, tool_call_id: toolId });
        continue;
      }

      let toolOutput = '';
      let toolExitCode = 0;
      const toolStart = performance.now();

      if (cmd.startsWith('plan ')) {
        const planArgs = cmd.slice(5).trim();
        const { action, params } = parsePlanCommand(planArgs);
        console.log(theme.bracketTag('plan', action));
        switch (action) {
          case 'create':
            toolOutput = createPlan(params[0] || 'Untitled Plan', params.slice(1));
            break;
          case 'done':
            toolOutput = updatePlanStep(parseInt(params[0]) || 0, 'done');
            break;
          case 'progress':
            toolOutput = updatePlanStep(parseInt(params[0]) || 0, 'in_progress');
            break;
          case 'show':
            toolOutput = showPlan();
            break;
          case 'clear':
            toolOutput = clearPlan();
            break;
          default:
            toolOutput = 'Unknown plan action. Use: create, done, progress, show, clear';
            toolExitCode = 1;
        }
      } else if (cmd.startsWith('todo ')) {
        const todoArgs = cmd.slice(5).trim();
        const { action, params } = parseTodoCommand(todoArgs);
        console.log(theme.bracketTag('todo', action));
        switch (action) {
          case 'add':
            toolOutput = addTodo(params);
            break;
          case 'done':
            toolOutput = doneTodo(params);
            break;
          case 'remove':
          case 'rm':
            toolOutput = removeTodo(params);
            break;
          case 'list':
          case 'ls':
            toolOutput = listTodos();
            break;
          default:
            toolOutput = 'Unknown todo action. Use: add, done, remove, list';
            toolExitCode = 1;
        }
      } else if (cmd.startsWith('question ')) {
        const qArgs = cmd.slice(9).trim();
        const { question, choices } = parseQuestionCommand(qArgs);
        console.log(theme.bracketTag('question', question));
        messages.push({
          role: 'tool',
          content: `Question asked: ${question}`,
          tool_call_id: toolId,
        });
        return {
          messages,
          questionPending: { question, choices: choices.length > 0 ? choices : undefined },
        };
      } else if (cmd.startsWith('approve ')) {
        const approveArgs = cmd.slice(8).trim();
        const action = parseApproveCommand(approveArgs);
        console.log(theme.bracketTag('approve', action));
        messages.push({
          role: 'tool',
          content: `Approval requested: ${action}`,
          tool_call_id: toolId,
        });
        return {
          messages,
          questionPending: { question: `Approve: ${action}?`, choices: ['Yes', 'No'] },
        };
      } else if (isMCPCommand(cmd)) {
        const mcpCmd = parseMCPCommand(cmd);
        if (mcpCmd) {
          console.log(theme.bracketTag('mcp', `${mcpCmd.server}/${mcpCmd.tool}`));
          toolOutput = callMCPTool(process.cwd(), mcpCmd.server, mcpCmd.tool, mcpCmd.args);
        } else {
          toolOutput = 'Invalid MCP command. Format: mcp <server> <tool> [args_json]';
          toolExitCode = 1;
        }
      } else {
        const result = await registry.execute({ id: toolId, name: 'bash', arguments: { cmd, timeout: parsed.arguments?.timeout ?? 120 } });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;
      }

      const toolTime = ((performance.now() - toolStart) / 1000).toFixed(1);
      console.log(theme.timingLine(toolTime, toolExitCode));
      if (toolExitCode !== 0) {
        const errText = toolOutput;
        for (const line of errText.split('\n').slice(0, 5)) {
          console.log(`  ${theme.error(line)}`);
        }
        autoLearnFromError(cmd, toolExitCode !== 0 ? toolOutput : '', '');
      }

      runPostToolUseHooks(process.cwd(), parsed.name, cmd, toolOutput, toolExitCode);

      messages.push({
        role: 'tool',
        content: toolOutput.slice(0, 4000),
        tool_call_id: toolId,
      });
  }
  return { messages };
}
