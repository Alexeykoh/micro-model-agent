import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as os from 'node:os';
import { loadAllMemoryDetailed } from './memory.js';
import { getOrBuildProjectMap } from '../indexer/cache.js';
import { loadAgentsMd, listInstalledSkills, formatSkillsBlock, type Skill } from '../skills/loader.js';
import { logInfo, logDebug } from '../logger.js';

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

## Plan / Todo / Question / Approve (native tools):
  {"name":"plan","arguments":{"name":"Todo App","steps":["Step 1","Step 2"]}}
  {"name":"plan","arguments":{"TaskName":"Todo App","Steps":"1. Init\n2. Create\n3. Test"}}
  {"name":"todo","arguments":{"action":"add","text":"Implement feature X"}}
  {"name":"todo","arguments":{"action":"list"}}
  {"name":"question","arguments":{"question":"What color?","choices":["Red","Blue"]}}
  {"name":"approve","arguments":{"action":"Delete file foo.ts"}}

## Web tools (search & fetch):
  {"name":"web_search","arguments":{"query":"weather in Minsk","maxResults":5}}
  {"name":"web_fetch","arguments":{"url":"https://example.com"}}

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
5. The JSON inside <tool_call> must be VALID JSON. Escape " inside values as \\".
   If your command contains double quotes, wrap them in escaped form.
6. For large files (>200 lines), use offset/limit with read_file:
   {"name":"read_file","arguments":{"path":"file.ts","offset":1,"limit":100}}
   {"name":"read_file","arguments":{"path":"file.ts","offset":101,"limit":100}}
   Or use grep_search to find specific content: {"name":"grep_search","arguments":{"pattern":"function","include":"*.ts"}}
7. SKILLS AND PLANNING: For complex tasks (3+ steps):
   a. If skills are NOT loaded yet: suggest them: "Рекомендую @skill1 @skill2"
   b. If skills ARE loaded (you see "Skills loaded" in context): DO NOT suggest skills again — they are already loaded
   c. IMMEDIATELY create a plan and start executing
   d. Create a plan: plan create TaskName Step1 Step2 Step3
   e. Mark current step as in_progress before executing it
   f. Mark step as done only AFTER verifying the result (exit code 0 + file exists)
   Example: User: "Создай REST API" → You: plan create REST API init-project create-schemas
8. FOR SIMPLE TASKS (1-2 steps): Just do it, no plan needed. Use common sense.
9. NEVER JUST TALK — ALWAYS ACT. Do NOT say "напиши навыки в следующем сообщении" or similar waiting phrases. If skills are loaded, START WORKING IMMEDIATELY.
10. When skills are already loaded in your context, you MUST use filesystem tools (write_file, create_dir, etc.) for file operations. Do NOT ask the user to load skills again.`;

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

const systemPromptCache = new Map<string, string>();

export function invalidateSystemPromptCache(): void {
  systemPromptCache.clear();
}

export function buildSystemPrompt(extraSkills?: Skill[]): string {
  const start = performance.now();
  const key = `${process.cwd()}:${extraSkills?.map(s => s.name).sort().join(',') || ''}`;
  const cached = systemPromptCache.get(key);
  if (cached) {
    logDebug('SYSTEM', 'buildSystemPrompt: cache hit');
    return cached;
  }
  logDebug('SYSTEM', 'buildSystemPrompt: building from scratch');

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

  const allSkills = listInstalledSkills();
  const skillsHint = allSkills.length > 0
    ? `\n## Available Skills (${allSkills.length})\nSkills contain ready-made workflows, best practices, and step-by-step guides.\nFor complex tasks (3+ steps): SUGGEST skills FIRST → User loads them → You READ them → Create plan BASED ON skill content.\nDo NOT put @skill-name inside tool_call. Just tell the user which skill to load.\nWorkflow:\n  1. User asks: "Создай REST API"\n  2. You: "Рекомендую @typescript-expert @nodejs-expert — напиши их в следующем сообщении."\n  3. User: "@typescript-expert @nodejs-expert"\n  4. Skills injected into this prompt — you READ them\n  5. You create plan BASED ON skill guidance: plan create REST API ...\n  6. You execute plan step by step\n\nInstalled skills: ${allSkills.map(s => '@' + s).join(' ')}`
    : '';

  const base = [header, platformBlock, sysInfo, memory, projectMap, agentsBlock, skillsHint].filter(Boolean).join('\n');
  const result = base + (extraSkills && extraSkills.length > 0 ? '\n\n' + formatSkillsBlock(extraSkills) : '');
  const elapsed = (performance.now() - start).toFixed(0);
  logInfo('SYSTEM', `buildSystemPrompt: ${result.length} chars in ${elapsed}ms`);
  systemPromptCache.set(key, result);
  return result;
}
