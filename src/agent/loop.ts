import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as os from 'node:os';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { loadAllMemory } from './memory.js';

const SYSTEM_PROMPT_CORE = `You are MMA — MiMo Agent, an AI coding assistant.
You help with software engineering tasks in the project directory.

Available tool — bash:
  Execute shell commands. Use for ALL operations: read/write files, git, npm, etc.
  To call it, output EXACTLY this format (on its own line):
  <tool_call>{"name":"bash","arguments":{"cmd":"your command here"}}</tool_call>

Examples:
  <tool_call>{"name":"bash","arguments":{"cmd":"dir"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"cat src/index.ts"}}</tool_call>
  <tool_call>{"name":"bash","arguments":{"cmd":"npm test"}}</tool_call>

Rules:
1. Use bash for EVERYTHING.
2. Write files with: Set-Content -Path file.ts -Value "content" (or Out-File for multi-line)
3. Read files with: Get-Content file.ts (or just cat)
4. Always respond in the user's language (Русский или English).
5. Think step by step. Make multiple bash calls if needed.
6. When done, summarize what you did.`;

function buildSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('ru-RU');
  const platformName = os.platform() === 'win32' ? 'Windows' : os.platform();
  let osVersion = platformName;
  try { osVersion += ` (${os.version()})`; } catch { /* ignore */ }

  let projectName = 'unknown';
  const pkgPath = resolve(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    try { projectName = JSON.parse(readFileSync(pkgPath, 'utf-8')).name || 'unknown'; } catch { /* ignore */ }
  }

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

  const memory = loadAllMemory();
  return SYSTEM_PROMPT_CORE + sysInfo + (memory ? '\n' + memory : '');
}

const TOOL_CALL_RE = /<tool_call>\s*(\{.*?\})\s*<\/tool_call>/s;

export async function runAgentLoop(
  provider: LLMProvider,
  registry: ToolRegistry,
  prompt: string,
  contextManager?: ContextManager,
): Promise<void> {
  const { prompt: enrichedPrompt, files } = await parseFileRefs(prompt);

  if (files.length > 0) {
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    console.log(`  Loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`);
    console.log();
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: enrichedPrompt },
  ];

  const ctx = contextManager ?? new ContextManager(provider.contextWindow);

  for (let step = 0; step < 25; step++) {
    await ctx.updateTokens(messages);
    console.log(`  ${ctx.formatUsage()}`);

    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      console.log(`  [compact] ${before} → ${messages.length} messages`);
      await ctx.updateTokens(messages);
    }

    const fullText: string[] = [];

    try {
      for await (const chunk of provider.chat(messages, { temperature: 0.3, max_tokens: 4096 })) {
        if (chunk.content) {
          fullText.push(chunk.content);
          process.stdout.write(chunk.content);
        }
      }
    } catch (e: any) {
      console.error(`\n[LLM] ${e.message}`);
      console.log('[LLM] Check that your server is running (LM Studio on localhost:1234 or Ollama)');
      return;
    }

    const response = fullText.join('');
    console.log();

    if (!response.trim()) {
      console.log('[model returned empty response]');
      return;
    }

    messages.push({ role: 'assistant', content: response });

    const match = response.match(TOOL_CALL_RE);
    if (!match) return;

    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name !== 'bash') {
        console.log(`  [unknown tool: ${parsed.name}]`);
        return;
      }

      const cmd = String(parsed.arguments?.cmd ?? '').trim();
      if (!cmd) {
        console.log('  [empty command]');
        return;
      }

      const toolId = `call-${Date.now()}-${step}`;
      console.log(`  [bash] ${cmd}`);
      const result = registry.execute({ id: toolId, name: 'bash', arguments: { cmd, timeout: parsed.arguments?.timeout ?? 120 } });
      const output = result.stdout || result.stderr || '(no output)';
      console.log(`  [exit ${result.exitCode}]`);

      messages.push({
        role: 'tool',
        content: output.slice(0, 4000),
        tool_call_id: toolId,
      });
    } catch (e: any) {
      console.log(`  [parse error] ${e.message}`);
      return;
    }
  }
}
