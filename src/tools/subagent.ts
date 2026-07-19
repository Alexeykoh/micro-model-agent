import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from './registry.js';
import { ContextManager } from '../agent/context.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { checkFileSyntax } from './syntax-check.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { logLLMRequest, logLLMResponse } from '../logger.js';

// ─── Types ────────────────────────────────────────────────

export interface IsolatedLoopResult {
  createdFiles: string[];
  errors: string[];
  summary: string;
  turns: number;
}

// ─── Context builder ──────────────────────────────────────

export function buildSubagentContext(cwd: string): string {
  const lines: string[] = [];

  try {
    const { readdirSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const srcDir = join(cwd, 'src');
    if (statSync(srcDir).isDirectory()) {
      const files = readdirSync(srcDir, { recursive: true })
        .filter((f: string) => /\.(ts|tsx|js|jsx)$/.test(f))
        .slice(0, 20);
      if (files.length > 0) {
        lines.push('Existing files: ' + files.join(', '));
      }
    }
  } catch { /* no src dir */ }

  try {
    const { readFileSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      if (deps.length > 0) lines.push('Dependencies: ' + deps.join(', '));
      if (devDeps.length > 0) lines.push('DevDependencies: ' + devDeps.join(', '));
      lines.push('Module type: ' + (pkg.type || 'commonjs'));
    }
  } catch { /* no package.json */ }

  try {
    const { readFileSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const tsconfigPath = join(cwd, 'tsconfig.json');
    if (existsSync(tsconfigPath)) {
      lines.push('Has tsconfig.json');
    }
  } catch { /* no tsconfig */ }

  return lines.join('\n');
}

// ─── Tool call parsing (duplicated from loop.ts) ───────────

export function extractAllToolCalls(response: string): string[] {
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

    block = block.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');

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

    if (depth > 0 && jsonStart < block.length) {
      results.push(block.slice(jsonStart));
    }
  }

  return results;
}

export function validateToolCall(parsed: any): { valid: boolean; name?: string; cmd?: string; error?: string } {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Not an object' };
  }

  const VALID_TOOLS = new Set(['bash', 'plan', 'todo', 'question', 'approve', 'theme', 'user_profile', 'subagent', 'read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir', 'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search', 'grep_search', 'tree', 'web_search', 'web_fetch']);

  if (!parsed.name || !VALID_TOOLS.has(parsed.name)) {
    return { valid: false, error: `Unknown tool: ${parsed.name}` };
  }
  if (!parsed.arguments || typeof parsed.arguments !== 'object') {
    return { valid: false, error: 'Missing arguments' };
  }

  if (parsed.name === 'bash') {
    const cmd = String(parsed.arguments.cmd ?? '').trim();
    if (!cmd) {
      return { valid: false, error: 'Empty command' };
    }
    return { valid: true, name: parsed.name, cmd };
  }

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
    web_search: ['query'],
    web_fetch: ['url'],
    user_profile: [],
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

// ─── LLM call (duplicated from loop.ts) ───────────────────

export async function doChat(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  retries = 1,
  showThinking = false,
): Promise<{ response: string; genTimeMs: number }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;
    let reasoningBuf: string | false = false;

    if (signal?.aborted) return { response: '', genTimeMs: 0 };

    const lastMsg = messages[messages.length - 1];
    logLLMRequest(provider.model, messages.length, lastMsg?.content || '');

    renderer.writeSpinner();

    try {
      let buf = '';
      for await (const chunk of provider.chat(messages, { temperature: 0.7, max_tokens: 8192, signal, showThinking })) {
        if (!chunk.content && !chunk.reasoning) continue;
        if (chunk.content) fullText.push(chunk.content);

        if (!started) {
          renderer.clearSpinner();
          started = true;
        }

        if (chunk.reasoning) {
          if (showThinking) {
            if (reasoningBuf === false) {
              renderer.writeNewline();
              renderer.writeDim('┈ reasoning ┈');
              reasoningBuf = '';
            }
            reasoningBuf += chunk.reasoning;
          }
          continue;
        }

        if (reasoningBuf !== false) {
          renderer.writeNewline();
          renderer.writeDim(reasoningBuf);
          reasoningBuf = false;
        }

        buf += chunk.content;

        while (buf.length > 0) {
          const tcStart = buf.indexOf('<tool_call>');
          const tcEnd = buf.indexOf('</tool_call>');

          if (tcStart === -1 && tcEnd === -1) {
            if (buf) renderer.writeMarkdownChunk(buf);
            buf = '';
            break;
          }

          if (tcStart !== -1 && (tcEnd === -1 || tcStart < tcEnd)) {
            if (tcStart > 0) {
              renderer.writeMarkdownChunk(buf.slice(0, tcStart));
            }
            buf = buf.slice(tcStart);
            const closeIdx = buf.indexOf('</tool_call>');
            if (closeIdx !== -1) {
              buf = buf.slice(closeIdx + '</tool_call>'.length);
            }
            break;
          }

          if (tcEnd !== -1 && (tcStart === -1 || tcEnd < tcStart)) {
            renderer.writeMarkdownChunk(buf.slice(0, tcEnd));
            buf = buf.slice(tcEnd + '</tool_call>'.length);
          }
        }
      }
    if (reasoningBuf !== false) {
      renderer.writeNewline();
      renderer.writeDim(reasoningBuf);
    }

    } catch (e: any) {
      if (e.name === 'AbortError') {
        logLLMResponse(provider.model, 0, performance.now() - startTime, 'Aborted');
        return { response: '', genTimeMs: 0 };
      }
      logLLMResponse(provider.model, 0, performance.now() - startTime, e.message);
      renderer.writeError(`\n[LLM] ${e.message}`);
      renderer.writeWarning('[LLM] Check that your server is running (LM Studio on localhost:1234 or Ollama)');
      return { response: '', genTimeMs: 0 };
    }

    const genTimeMs = performance.now() - startTime;
    const response = fullText.join('');
    renderer.commitMarkdown();

    if (response.trim()) {
      logLLMResponse(provider.model, response.length, genTimeMs);
      return { response, genTimeMs };
    }

    if (attempt < retries) {
      renderer.writeDim(`[retry ${attempt + 1}/${retries}]`);
    }
  }

  return { response: '', genTimeMs: 0 };
}

// ─── Isolated agent loop ──────────────────────────────────

export async function runIsolatedLoop(
  provider: LLMProvider,
  registry: ToolRegistry,
  task: string,
  existingFiles: string,
  cwd: string,
  quiet: boolean,
  renderer: OutputRenderer,
): Promise<IsolatedLoopResult> {
  const createdFiles: string[] = [];
  const errors: string[] = [];

  const systemPrompt = buildSystemPrompt(undefined, 'base');

  const contextInfo = existingFiles
    ? `\n\nСуществующие файлы в проекте:\n${existingFiles}\nПосмотри package.json для списка пакетов.`
    : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task + contextInfo },
  ];

  const ctx = new ContextManager(provider.contextWindow);
  const maxSteps = 20;

  for (let step = 0; step < maxSteps; step++) {
    await ctx.updateTokens(messages);

    if (ctx.needsCompact && messages.length > 6) {
      messages.splice(0, messages.length, ...ctx.compact(messages));
      await ctx.updateTokens(messages);
    }

    const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, 1, false);

    if (!response.trim()) break;

    messages.push({ role: 'assistant', content: response });

    const allJsonRaw = extractAllToolCalls(response);
    const validCalls: { parsed: any; cmd?: string }[] = [];

    for (const jsonRaw of allJsonRaw) {
      let p: any = null;
      try { p = JSON.parse(jsonrepair(jsonRaw)); } catch {
        try { p = JSON.parse(jsonRaw); } catch { /* skip */ }
      }
      if (p) {
        const v = validateToolCall(p);
        if (v.valid) validCalls.push({ parsed: p, cmd: v.cmd });
      }
    }

    if (validCalls.length === 0) break;

    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === 'bash';
      const toolId = `sub-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;

      let toolOutput = '';
      let toolExitCode = 0;

      if (parsed.name === 'subagent') {
        toolOutput = 'Subagents cannot spawn subagents (max depth 1)';
        toolExitCode = 1;
      } else if (!isBash) {
        const result = await registry.execute({ id: toolId, name: parsed.name, arguments: parsed.arguments });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;

        if (toolExitCode === 0 && (parsed.name === 'write_file' || parsed.name === 'edit_file')) {
          const filePath = String(parsed.arguments.path ?? '');
          if (filePath && !createdFiles.includes(filePath)) {
            createdFiles.push(filePath);
          }
        }

        if (toolExitCode === 0 && (parsed.name === 'write_file' || parsed.name === 'edit_file')) {
          const filePath = String(parsed.arguments.path ?? '');
          if (filePath && /\.(ts|tsx|js|jsx|json)$/.test(filePath)) {
            const { isAbsolute, relative } = await import('node:path');
            const relPath = isAbsolute(filePath) ? relative(cwd, filePath).replace(/\\/g, '/') : filePath;
            const syntaxResult = checkFileSyntax(relPath, cwd);
            if (syntaxResult !== 'OK') {
              errors.push(`${filePath}: ${syntaxResult.split('\n')[0]}`);
              toolOutput += `\nSYNTAX ERROR: ${syntaxResult}`;
            }
          }
        }
      } else {
        const result = await registry.execute({ id: toolId, name: 'bash', arguments: { cmd, timeout: parsed.arguments?.timeout ?? 30 } });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;
      }

      messages.push({ role: 'tool', content: toolOutput.slice(0, 8000), tool_call_id: toolId });
      messages.push({ role: 'user', content: 'Continue.' });
    }
  }

  const turns = messages.filter(m => m.role === 'assistant').length;
  const summary = createdFiles.length > 0
    ? `[Subagent done — ${createdFiles.length} file(s), ${turns} turns]\nFiles: ${createdFiles.join(', ')}${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`
    : `[Subagent done — no files, ${turns} turns]${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`;

  return { createdFiles, errors, summary, turns };
}

// ─── Tool definition ──────────────────────────────────────

import type { ToolDefinition } from './registry.js';

export const subagentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'subagent',
    description: 'Delegate a task to an isolated agent in a fresh context. Use for EACH file when creating 3+ new files. Arguments: task (required, what to do), existingFiles (optional, comma-separated files for context).',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the subagent should create/fix/check' },
        existingFiles: { type: 'string', description: 'Comma-separated files the subagent can read for context (optional)' },
      },
      required: ['task'],
    },
  },
};
