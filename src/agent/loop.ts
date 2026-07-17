import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as os from 'node:os';
import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { loadAllMemory, loadAllMemoryDetailed, autoLearnFromError } from './memory.js';
import { getOrBuildProjectMap } from '../indexer/cache.js';
import { loadAgentsMd, loadSkill, loadSkillsFromRefs, formatSkillsBlock, listInstalledSkills } from '../skills/loader.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { isMCPCommand, parseMCPCommand, callMCPTool } from '../tools/mcp.js';
import { createPlan, updatePlanStep, showPlan, clearPlan, parsePlanCommand } from '../tools/plan.js';
import { addTodo, doneTodo, removeTodo, listTodos, parseTodoCommand } from '../tools/todo.js';
import { askQuestion, parseQuestionCommand } from '../tools/question.js';
import { parseApproveCommand } from '../tools/approve.js';
import { checkFileSyntax } from '../tools/syntax-check.js';
import { getTheme } from '../styling/index.js';

const TOOL_FORMAT = `CRITICAL: Use filesystem tools for file operations — they are more reliable than bash.

To call a tool, output EXACTLY this format (on its own line):

<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>

## Filesystem Tools (USE THESE for file ops):

Read a file:
  {"name":"read_file","arguments":{"path":"src/index.ts"}}
  {"name":"read_file","arguments":{"path":"src/index.ts","offset":50,"limit":100}}

Write/create a file:
  {"name":"write_file","arguments":{"path":"src/utils.ts","content":"export function foo() { return 1; }"}}

Edit (find & replace):
  {"name":"edit_file","arguments":{"path":"src/index.ts","old_string":"old text","new_string":"new text"}}

List directory:
  {"name":"list_dir","arguments":{}}
  {"name":"list_dir","arguments":{"path":"src"}}

Create directory: {"name":"create_dir","arguments":{"path":"src/routes"}}
Delete file: {"name":"delete_file","arguments":{"path":"old-file.ts"}}
Copy file: {"name":"copy_file","arguments":{"source":"src/a.ts","destination":"src/b.ts"}}
Move/rename: {"name":"move_file","arguments":{"source":"old.ts","destination":"new.ts"}}
File info: {"name":"file_info","arguments":{"path":"src/index.ts"}}
Search files: {"name":"glob_search","arguments":{"pattern":"**/*.ts"}}
Search content: {"name":"grep_search","arguments":{"pattern":"function","include":"*.ts"}}
Directory tree: {"name":"tree","arguments":{"depth":2}}

## Bash (for non-file operations — npm, git, etc):
  {"name":"bash","arguments":{"cmd":"npm test"}}
  {"name":"bash","arguments":{"cmd":"git status"}}

NEVER output tool calls in any other format. ALWAYS use <tool_call> tags.`;

const CONVERSATION_FLOW = `## How This Works (IMPORTANT — read this carefully)

You are in a loop. Each turn works like this:

1. User sends a message
2. You respond with TEXT and/or TOOL CALLS
3. Tool results appear — then it is YOUR TURN AGAIN
4. Repeat until the task is done

### What you see after a tool executes:

You will see a message like:
  [tool result: "Written 42 bytes (3 lines) to src/index.ts"]

This is NOT the end. You MUST continue:
- If more files need work → call the next tool
- If the task is done → write a summary to the user
- If there was an error → explain it and fix it

### Example conversation:

User: "Create a file src/utils.ts with a hello function"

You:
<tool_call>{"name":"write_file","arguments":{"path":"src/utils.ts","content":"export function hello() { return 'world'; }"}}</tool_call>

[Tool result: "Written 52 bytes (1 lines) to src/utils.ts"]

You:
File src/utils.ts created successfully. It exports a hello() function that returns 'world'.

---

NEVER stop after a tool call. ALWAYS continue with either another tool call or a text reply.`;

const RULES_COMMON = `Rules:
1. Use filesystem tools for file operations (read_file, write_file, edit_file, list_dir, glob_search, grep_search, tree). Use bash ONLY for non-file commands (npm, git, etc).
2. Always respond in the user's language (Русский или English).
3. CRITICAL: After every tool call, CHECK the result (exit code + output).
   If exit code != 0, DO NOT claim success — tell the user about the error.
   Verify files were created before saying "done".
4. NEVER return an empty response. After receiving a tool result, you MUST either:
   a) Call another tool (if more work is needed), OR
   b) Write a text response to the user (summarize what was done, report errors, ask questions).
   Staying silent after a tool result is always wrong.
5. The JSON inside <tool_call> must be VALID JSON. Escape " inside values as \\\".
   If your command contains double quotes, wrap them in escaped form.
6. For large files (>200 lines), use offset/limit with read_file:
   {"name":"read_file","arguments":{"path":"file.ts","offset":1,"limit":100}}
   {"name":"read_file","arguments":{"path":"file.ts","offset":101,"limit":100}}
   Or use grep_search to find specific content: {"name":"grep_search","arguments":{"pattern":"function","include":"*.ts"}}
7. SKILLS FIRST, THEN PLAN: For complex tasks (3+ steps):
   a. Suggest relevant skills from Available Skills above: "Для этой задачи рекомендую @skill1 @skill2"
   b. User loads skills in next message: "@skill1 @skill2"
   c. Skills are injected into this prompt — READ the skill content carefully
   d. Create a plan BASED ON the skill's workflow: plan create TaskName Step1 Step2 Step3
   e. Mark current step as in_progress before executing it
   f. Mark step as done only AFTER verifying the result (exit code 0 + file exists)
   Example: User: "Создай REST API" → You: "Рекомендую @typescript-expert @nodejs-expert"
   User: "@typescript-expert @nodejs-expert" → Skills loaded → You read them → plan create REST API ...
8. FOR SIMPLE TASKS (1-2 steps): Just do it, no plan needed. Use common sense.`;

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
    ? [TOOL_FORMAT, CONVERSATION_FLOW, POWERSHELL_EXAMPLES, RULES_COMMON, POWERSHELL_RULES].join('\n\n')
    : [TOOL_FORMAT, CONVERSATION_FLOW, UNIX_EXAMPLES, RULES_COMMON, UNIX_RULES].join('\n\n');

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

  // Build available skills list for the model
  const allSkills = listInstalledSkills();
  const skillsHint = allSkills.length > 0
    ? `\n## Available Skills (${allSkills.length})\nSkills contain ready-made workflows, best practices, and step-by-step guides.\nFor complex tasks (3+ steps): SUGGEST skills FIRST → User loads them → You READ them → Create plan BASED ON skill content.\nDo NOT put @skill-name inside tool_call. Just tell the user which skill to load.\nWorkflow:\n  1. User asks: "Создай REST API"\n  2. You: "Рекомендую @typescript-expert @nodejs-expert — напиши их в следующем сообщении."\n  3. User: "@typescript-expert @nodejs-expert"\n  4. Skills injected into this prompt — you READ them\n  5. You create plan BASED ON skill guidance: plan create REST API ...\n  6. You execute plan step by step\n\nInstalled skills: ${allSkills.map(s => '@' + s).join(' ')}`
    : '';

  return [header, platformBlock, sysInfo, memory, projectMap, agentsBlock, skillsHint].filter(Boolean).join('\n');
}

function extractAllToolCalls(response: string): string[] {
  const results: string[] = [];
  let text = response;

  while (true) {
    const tcStart = text.indexOf('<tool_call>');
    if (tcStart === -1) break;

    const tcEnd = text.indexOf('</tool_call>', tcStart);
    let block: string;
    if (tcEnd !== -1) {
      block = text.slice(tcStart + '<tool_call>'.length, tcEnd);
      text = text.slice(tcEnd + '</tool_call>'.length);
    } else {
      block = text.slice(tcStart + '<tool_call>'.length);
      text = '';
    }

    // Strip markdown code fences
    block = block.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

    // Find JSON object
    const jsonStart = block.indexOf('{');
    if (jsonStart === -1) continue;

    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = jsonStart; i < block.length; i++) {
      const ch = block[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) {
        results.push(block.slice(jsonStart, i + 1));
        break;
      }
    }

    // If no closing brace, take everything
    if (depth > 0 && jsonStart < block.length) {
      results.push(block.slice(jsonStart));
    }
  }

  return results;
}

function extractToolCallJson(response: string): string | null {
  const calls = extractAllToolCalls(response);
  return calls.length > 0 ? calls[0] : null;
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

function validateToolCall(parsed: any): { valid: boolean; name?: string; cmd?: string; error?: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Not an object' };
  }

  const VALID_TOOLS = new Set(['bash', 'read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir', 'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search', 'grep_search', 'tree']);

  if (!parsed.name || !VALID_TOOLS.has(parsed.name)) {
    return { valid: false, error: `Unknown tool: ${parsed.name}` };
  }
  if (!parsed.arguments || typeof parsed.arguments !== 'object') {
    return { valid: false, error: 'Missing arguments' };
  }

  // For bash, require cmd argument
  if (parsed.name === 'bash') {
    const cmd = String(parsed.arguments.cmd ?? '').trim();
    if (!cmd) {
      return { valid: false, error: 'Empty command' };
    }
    return { valid: true, name: parsed.name, cmd };
  }

  // Validate required arguments for filesystem tools
  const REQUIRED_ARGS: Record<string, string[]> = {
    read_file: ['path'],
    write_file: ['path', 'content'],
    edit_file: ['path', 'old_string', 'new_string'],
    list_dir: [],
    create_dir: ['path'],
    delete_file: ['path'],
    copy_file: ['source', 'destination'],
    move_file: ['source', 'destination'],
    file_info: ['path'],
    glob_search: ['pattern'],
    grep_search: ['pattern'],
    tree: [],
  };

  const required = REQUIRED_ARGS[parsed.name] ?? [];
  const missing = required.filter(k => {
    const v = parsed.arguments[k];
    return v === undefined || v === null || v === '';
  });

  if (missing.length > 0) {
    return { valid: false, error: `Missing required argument(s): ${missing.join(', ')}. Tool "${parsed.name}" requires: ${required.join(', ')}` };
  }

  return { valid: true, name: parsed.name };
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

  const loadedSkills = loadSkillsFromRefs(prompt, process.cwd());
  const loadedSkillNames = new Set(loadedSkills.map(s => s.name));
  if (loadedSkills.length > 0) {
    console.log(theme.info(`  Loaded ${loadedSkills.length} skill(s): ${loadedSkills.map(s => s.name).join(', ')} (~${loadedSkills.reduce((s, sk) => s + sk.tokens, 0)} tokens)`));
  }

  if (files.length > 0) {
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    console.log(theme.info(`  Loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`));
    console.log();
  }

  const systemPrompt = buildSystemPrompt() + (loadedSkills.length > 0 ? '\n\n' + formatSkillsBlock(loadedSkills) : '');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(previousMessages || []),
    { role: 'user', content: enrichedPrompt },
  ];

  const ctx = contextManager ?? new ContextManager(provider.contextWindow);
  let consecutiveEmpty = 0;
  let pendingSyntaxError = '';

  for (let step = 0; step < 25; step++) {
    let skillsAutoLoaded = false;
    await ctx.updateTokens(messages);
    console.log(`  ${ctx.formatUsage()}`);

    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      console.log(theme.bracketTag('compact', `${before} → ${messages.length} messages`));
      await ctx.updateTokens(messages);
    }

    const { response } = await doChat(provider, messages);

    // Auto-load skills if model suggested them in response
    const suggestedSkillRefs = response.matchAll(/@(\w[\w-]*)/g);
    const newSkillNames: string[] = [];
    for (const match of suggestedSkillRefs) {
      const name = match[1];
      // Skip common non-skill words
      if (['email', 'api', 'id', 'json', 'url', 'http', 'https', 'localhost'].includes(name)) continue;
      if (!loadedSkillNames.has(name)) {
        const skill = loadSkill(name, process.cwd());
        if (skill) {
          newSkillNames.push(name);
          loadedSkills.push(skill);
          loadedSkillNames.add(name);
        }
      }
    }
    if (newSkillNames.length > 0) {
      skillsAutoLoaded = true;
      console.log(theme.info(`  Auto-loaded ${newSkillNames.length} skill(s): ${newSkillNames.join(', ')}`));
      // Rebuild system prompt with new skills
      messages[0] = { role: 'system', content: buildSystemPrompt() + '\n\n' + formatSkillsBlock(loadedSkills) };
      // Tell model skills are loaded — it should proceed with planning, and REMEMBER to use fs tools
      messages.push({ role: 'user', content: `[System: Skills loaded: ${newSkillNames.join(', ')}. They are in your context now. IMPORTANT: Use filesystem tools (write_file, create_dir, edit_file, read_file, etc.) for all file operations — NOT bash. Skills show bash examples for reference only. Create a plan and start working.]` });
    }

    if (!response.trim()) {
      consecutiveEmpty++;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'tool' && consecutiveEmpty <= 3) {
        const retryPrompt = consecutiveEmpty === 1
          ? 'The tool result is above. Your turn now. Either: (1) call the next tool using <tool_call>{"name":"...","arguments":{...}}</tool_call>, or (2) write a text reply to the user summarizing progress. Do NOT output nothing.'
          : 'You returned an empty response again. You MUST write something now. Example of what to write: "File created. Now I will create the next file..." or call another tool. Silence is not allowed.';
        messages.push({ role: 'user', content: retryPrompt });
        console.log(theme.dim(`  [empty response #${consecutiveEmpty}, retrying]`));
        continue;
      }
      console.log(theme.error(consecutiveEmpty > 3
        ? `[model returned empty response ${consecutiveEmpty} times in a row — stopping]`
        : '[model returned empty response]'));
      return { messages };
    }
    consecutiveEmpty = 0;

    messages.push({ role: 'assistant', content: response });

    // Extract ALL tool calls from response
    const allJsonRaw = extractAllToolCalls(response);

    // Try to parse each tool call
    const validCalls: { parsed: any; cmd?: string }[] = [];
    for (const jsonRaw of allJsonRaw) {
      let p: any = null;
      try {
        p = JSON.parse(jsonrepair(jsonRaw));
      } catch {
        try { p = JSON.parse(jsonRaw); } catch { /* continue */ }
      }

      if (p) {
        const v = validateToolCall(p);
        if (v.valid) {
          validCalls.push({ parsed: p, cmd: v.cmd });
        }
      }
    }

    // Also try fallback for any remaining
    if (validCalls.length === 0) {
      const fallback = extractToolCallFallback(response);
      if (fallback) {
        validCalls.push({ parsed: { name: 'bash', arguments: { cmd: fallback.cmd } }, cmd: fallback.cmd });
        console.log(theme.bracketTag('fallback', 'regex extracted command'));
      }
    }

    // If no valid calls, return (unless skills were just auto-loaded — continue to let model use them)
    if (validCalls.length === 0) {
      if (!skillsAutoLoaded) {
        return { messages };
      }
      // Skills were loaded — continue loop so model can plan with them
      continue;
    }

    // Process each tool call sequentially
    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === 'bash';
      const preview = isBash
        ? (cmd!.length > 200 ? cmd!.slice(0, 200) + '...' : cmd!)
        : JSON.stringify(parsed.arguments).slice(0, 200);
      const toolId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;

      console.log();
      console.log(theme.toolHeader(parsed.name));
      console.log(`  ${theme.dim(preview)}`);

      const hookCmd = isBash ? cmd! : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
      const preHook = runPreToolUseHooks(process.cwd(), parsed.name, hookCmd);
      if (!preHook.continue) {
        console.log(theme.bracketTag('hook blocked', preHook.message || ''));
        messages.push({ role: 'tool', content: `Hook blocked: ${preHook.message || ''}`, tool_call_id: toolId });
        continue;
      }

      // Block new write operations if there's a pending syntax error
      if (pendingSyntaxError && !isBash) {
        const isWriteOp = parsed.name === 'write_file' || parsed.name === 'edit_file';
        if (isWriteOp && String(parsed.arguments.path ?? '') !== pendingSyntaxError) {
          const blocked = `BLOCKED: You have a syntax error in ${pendingSyntaxError}. Fix it first before writing new files.`;
          console.log(theme.error(`  [blocked: fix syntax error in ${pendingSyntaxError} first]`));
          messages.push({ role: 'tool', content: blocked, tool_call_id: toolId });
          continue;
        }
      }

      let toolOutput = '';
      let toolExitCode = 0;
      const toolStart = performance.now();

      // Bash-specific prefix commands (plan/todo/question/approve/mcp)
      if (isBash && cmd!.startsWith('plan ')) {
        const planArgs = cmd!.slice(5).trim();
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
      } else if (isBash && cmd!.startsWith('todo ')) {
        const todoArgs = cmd!.slice(5).trim();
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
      } else if (isBash && cmd!.startsWith('question ')) {
        const qArgs = cmd!.slice(9).trim();
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
      } else if (isBash && cmd!.startsWith('approve ')) {
        const approveArgs = cmd!.slice(8).trim();
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
      } else if (isBash && isMCPCommand(cmd!)) {
        const mcpCmd = parseMCPCommand(cmd!);
        if (mcpCmd) {
          console.log(theme.bracketTag('mcp', `${mcpCmd.server}/${mcpCmd.tool}`));
          toolOutput = callMCPTool(process.cwd(), mcpCmd.server, mcpCmd.tool, mcpCmd.args);
        } else {
          toolOutput = 'Invalid MCP command. Format: mcp <server> <tool> [args_json]';
          toolExitCode = 1;
        }
      } else if (!isBash) {
        // Filesystem or other dedicated tool — call registry directly
        const result = await registry.execute({ id: toolId, name: parsed.name, arguments: parsed.arguments });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;
      } else {
        // Plain bash command
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
        autoLearnFromError(hookCmd, toolExitCode !== 0 ? toolOutput : '', '');
      }

      runPostToolUseHooks(process.cwd(), parsed.name, hookCmd, toolOutput, toolExitCode);

      // Syntax check after file write operations
      let hasSyntaxError = false;
      if (toolExitCode === 0) {
        const isWriteOp = isBash
          ? (cmd!.match(/Set-Content|Add-Content/))
          : (parsed.name === 'write_file' || parsed.name === 'edit_file');
        if (isWriteOp) {
          const rawPath = isBash
            ? cmd!.match(/-Path\s+['"]?([^'"]+\.(?:ts|tsx|js|jsx|json))['"]?/i)?.[1]?.replace(/\\/g, '/')
            : String(parsed.arguments.path ?? '');
          if (rawPath && /\.(ts|tsx|js|jsx|json)$/.test(rawPath)) {
            // Make path relative to cwd if it's absolute
            const { isAbsolute, relative } = await import('node:path');
            const filePath = isAbsolute(rawPath) ? relative(process.cwd(), rawPath).replace(/\\/g, '/') : rawPath;
            const syntaxResult = checkFileSyntax(filePath, process.cwd());
            if (syntaxResult !== 'OK') {
              const errorLines = syntaxResult.split('\n').filter(l => l.trim());
              const shown = errorLines.slice(0, 3);
              const extra = errorLines.length > 3 ? ` (+${errorLines.length - 3} more)` : '';
              console.log(theme.bracketTag('syntax', `${shown.join('; ')}${extra}`));

              // Extract line numbers from errors and show the actual code
              const fullPath = join(process.cwd(), filePath);
              let contextLines = '';
              try {
                const fileContent = readFileSync(fullPath, 'utf-8').split('\n');
                for (const errLine of shown) {
                  const lineMatch = errLine.match(/\((\d+),\d+\)/);
                  if (lineMatch) {
                    const lineNum = parseInt(lineMatch[1]);
                    if (lineNum > 0 && lineNum <= fileContent.length) {
                      const start = Math.max(0, lineNum - 2);
                      const end = Math.min(fileContent.length, lineNum + 1);
                      contextLines += `\n--- Line ${lineNum} ---\n`;
                      for (let i = start; i < end; i++) {
                        const marker = i === lineNum - 1 ? ' >> ' : '    ';
                        contextLines += `${marker}${i + 1}: ${fileContent[i]}\n`;
                      }
                    }
                  }
                }
              } catch { /* ignore read errors */ }

              toolOutput = `SYNTAX ERROR in ${filePath}:\n${syntaxResult}${contextLines}\n\nDo NOT rewrite the entire file. Use edit_file to fix the specific broken line:\n{"name":"edit_file","arguments":{"path":"${filePath}","old_string":"broken code here","new_string":"fixed code here"}}`;
              hasSyntaxError = true;
              pendingSyntaxError = filePath;
            } else {
              // File has no errors — clear pending if this was the file with errors
              if (pendingSyntaxError === filePath) {
                pendingSyntaxError = '';
              }
            }
          }
        }
      }

      // Auto-show plan after plan operations
      if (isBash && cmd!.startsWith('plan ') && toolExitCode === 0) {
        const planOutput = showPlan();
        if (planOutput && !planOutput.startsWith('No active plan')) {
          console.log();
          console.log(planOutput);
        }
      }

      // Auto-show todos after todo operations
      if (isBash && cmd!.startsWith('todo ') && toolExitCode === 0) {
        const todoOutput = listTodos();
        if (todoOutput) {
          console.log();
          console.log(todoOutput);
        }
      }

      messages.push({
        role: 'tool',
        content: toolOutput.slice(0, 4000),
        tool_call_id: toolId,
      });

      // If syntax error found — stop processing more tool calls in this batch
      if (hasSyntaxError) {
        break;
      }
    } // end for each tool call
  }
  return { messages };
}
