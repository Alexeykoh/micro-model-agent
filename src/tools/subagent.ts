import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from './registry.js';
import { ContextManager } from '../agent/context.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { checkFileSyntax } from './syntax-check.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { logInfo, logDebug, logWarn, logLLMRequest, logLLMResponse, logToolCall } from '../logger.js';

/**
 * Изолированный цикл агента для субагентов.
 *
 * Субагенты работают в изолированном контексте — они не видят
 * историю родительского агента, но получают информацию о структуре
 * проекта (файлы, зависимости, tsconfig).
 *
 * Используется для:
 * - Создания отдельных файлов в multi-file проектах
 * - Запуска верификации (tsc --noEmit)
 * - Изоляции задач для предотвращения потери контекста
 *
 * @module tools/subagent
 */

// ─── Types ────────────────────────────────────────────────

/** Результат выполнения изолированного цикла субагента */
export interface IsolatedLoopResult {
  createdFiles: string[];
  errors: string[];
  summary: string;
  turns: number;
}

// ─── Context builder ──────────────────────────────────────

/**
 * Собирает контекст для субагента: список файлов, зависимости, tsconfig.
 * Сканирует все директории проекта (не только src/).
 *
 * @param cwd - корневая директория проекта
 * @returns Текстовый контекст для system prompt субагента
 */
export function buildSubagentContext(cwd: string): string {
  const lines: string[] = [];

  // Scan ALL directories for existing source files (not just src/)
  try {
    const { readdirSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const entries = readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const dirPath = join(cwd, entry.name);
      try {
        const files = readdirSync(dirPath, { recursive: true })
          .filter((f: string) => /\.(ts|tsx|js|jsx)$/.test(f))
          .slice(0, 20);
        if (files.length > 0) {
          lines.push(`Files in ${entry.name}/: ${files.join(', ')}`);
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* no entries */ }

  // Include root-level .ts/.js files too
  try {
    const { readdirSync } = require('node:fs');
    const rootFiles = readdirSync(cwd)
      .filter((f: string) => /\.(ts|js)$/.test(f) && !f.startsWith('.'));
    if (rootFiles.length > 0) {
      lines.push('Root files: ' + rootFiles.join(', '));
    }
  } catch { /* skip */ }

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

// ─── Tool call parsing ───────────────────────────────────

/**
 * Извлекает все JSON-блоки из тегов <tool_call>...</tool_call>.
 * Дублируется из loop.ts для изоляции субагентов.
 *
 * @param response - ответ модели
 * @returns Массив JSON-строк из tool calls
 */
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

/**
 * Валидация tool call: проверка имени инструмента и обязательных аргументов.
 *
 * @param parsed - распарсенный JSON из tool call
 * @returns Результат валидации с именем инструмента и командой (для bash)
 */
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

// ─── LLM call ───────────────────────────────────────────

/**
 * Отправка запроса к LLM с streaming-ответом.
 * Поддерживает retry при ошибках и отображение "мышления" модели.
 *
 * @param provider - провайдер LLM
 * @param messages - история сообщений
 * @param renderer - рендерер для отображения streaming
 * @param signal - сигнал прерывания
 * @param retries - количество повторных попыток
 * @param showThinking - показывать ли "мышление" модели
 * @param caller - кто вызвал (main/subagent)
 */
export async function doChat(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  retries = 1,
  showThinking = false,
  caller: 'main' | 'subagent' = 'main',
): Promise<{ response: string; genTimeMs: number }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;
    let reasoningBuf: string | false = false;

    if (signal?.aborted) return { response: '', genTimeMs: 0 };

    const lastMsg = messages[messages.length - 1];
    logLLMRequest(provider.model, messages.length, lastMsg?.content || '', caller);

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
        logLLMResponse(provider.model, 0, performance.now() - startTime, 'Aborted', caller);
        return { response: '', genTimeMs: 0 };
      }
      logLLMResponse(provider.model, 0, performance.now() - startTime, e.message, caller);
      renderer.writeError(`\n[LLM] ${e.message}`);
      renderer.writeWarning('[LLM] Check that your server is running (LM Studio on localhost:1234 or Ollama)');
      return { response: '', genTimeMs: 0 };
    }

    const genTimeMs = performance.now() - startTime;
    const response = fullText.join('');
    renderer.commitMarkdown();

    if (response.trim()) {
      logLLMResponse(provider.model, response.length, genTimeMs, undefined, caller);
      return { response, genTimeMs };
    }

    if (attempt < retries) {
      renderer.writeDim(`[retry ${attempt + 1}/${retries}]`);
    }
  }

  return { response: '', genTimeMs: 0 };
}

// ─── Isolated agent loop ──────────────────────────────────

/**
 * Запуск изолированного цикла агента (субагент).
 *
 * Субагент:
 * - Получает свежий контекст (system prompt + задача + info о проекте)
 * - Работает максимум 20 ходов
 * - Не может создавать вложенных субагентов (max depth 1)
 * - Автоматически компактирует контекст при необходимости
 * - Отслеживает созданные файлы и ошибки
 *
 * @returns Результат: созданные файлы, ошибки, краткое описание, количество ходов
 */
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
  const startTime = performance.now();

  logInfo('SUBAGENT', `START | task: "${task.slice(0, 200)}" | context window: ${provider.contextWindow}`);

  // Always build auto-context from project, even if model didn't pass existingFiles
  const autoContext = buildSubagentContext(cwd);
  const mergedContext = existingFiles
    ? existingFiles + '\n' + autoContext
    : autoContext;

  if (mergedContext) {
    logDebug('SUBAGENT', `context (${mergedContext.split('\n').length} lines):\n${mergedContext}`);
  }

  const systemPrompt = buildSystemPrompt(undefined, 'base');

  const contextInfo = mergedContext
    ? `\n\nКонтекст проекта:\n${mergedContext}\nПосмотри package.json для списка пакетов. Используй read_file для чтения существующих файлов.`
    : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task + contextInfo },
  ];

  const ctx = new ContextManager(provider.contextWindow);
  const maxSteps = 20;
  let toolCallCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    await ctx.updateTokens(messages);

    if (step === 0 || step % 5 === 0) {
      logDebug('SUBAGENT', `step ${step} | ${messages.length} msgs | ${ctx.totalTokens} tokens (${ctx.usagePercent.toFixed(1)}%)`);
    }

    if (ctx.needsCompact && messages.length > 6) {
      logInfo('SUBAGENT', `COMPACT at step ${step} | ${ctx.totalTokens} tokens (${ctx.usagePercent.toFixed(1)}%)`);
      messages.splice(0, messages.length, ...ctx.compact(messages));
      await ctx.updateTokens(messages);
      logInfo('SUBAGENT', `after compact | ${messages.length} msgs | ${ctx.totalTokens} tokens`);
    }

    const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, 1, false, 'subagent');

    if (!response.trim()) {
      logDebug('SUBAGENT', `empty response at step ${step}, stopping`);
      break;
    }

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

    if (validCalls.length === 0) {
      logDebug('SUBAGENT', `no valid tool calls at step ${step}, stopping`);
      break;
    }

    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === 'bash';
      const toolId = `sub-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;
      toolCallCount++;

      let toolOutput = '';
      let toolExitCode = 0;

      if (parsed.name === 'subagent') {
        toolOutput = 'Subagents cannot spawn subagents (max depth 1)';
        toolExitCode = 1;
        logWarn('SUBAGENT', `nested subagent blocked at step ${step}`);
      } else if (!isBash) {
        const preview = parsed.name === 'write_file'
          ? String(parsed.arguments.path ?? '').slice(-60)
          : parsed.name === 'edit_file'
            ? String(parsed.arguments.path ?? '').slice(-60)
            : JSON.stringify(parsed.arguments).slice(0, 80);
        logToolCall(`sub:${parsed.name}`, preview);

        const result = await registry.execute({ id: toolId, name: parsed.name, arguments: parsed.arguments });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;

        if (toolExitCode !== 0) {
          logDebug('SUBAGENT', `tool ${parsed.name} failed: exit ${toolExitCode} | ${toolOutput.slice(0, 200)}`);
        }

        if (toolExitCode === 0 && (parsed.name === 'write_file' || parsed.name === 'edit_file')) {
          const filePath = String(parsed.arguments.path ?? '');
          if (filePath && !createdFiles.includes(filePath)) {
            createdFiles.push(filePath);
            logInfo('SUBAGENT', `created: ${filePath}`);
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
              logWarn('SUBAGENT', `syntax error in ${filePath}: ${syntaxResult.split('\n')[0]}`);
            }
          }
        }
      } else {
        logToolCall('sub:bash', String(cmd).slice(0, 80));

        const result = await registry.execute({ id: toolId, name: 'bash', arguments: { cmd, timeout: parsed.arguments?.timeout ?? 30 } });
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;

        if (toolExitCode !== 0) {
          logDebug('SUBAGENT', `bash failed: exit ${toolExitCode} | ${toolOutput.slice(0, 200)}`);
        }
      }

      messages.push({ role: 'tool', content: toolOutput.slice(0, 8000), tool_call_id: toolId });
      messages.push({ role: 'user', content: 'Continue.' });
    }
  }

  const turns = messages.filter(m => m.role === 'assistant').length;
  const elapsedMs = performance.now() - startTime;

  await ctx.updateTokens(messages);
  const finalTokens = ctx.totalTokens;
  const finalUsage = ctx.usagePercent;

  logInfo('SUBAGENT', `DONE | ${turns} turns | ${toolCallCount} tool calls | ${createdFiles.length} files created | ${errors.length} errors | ${finalTokens} tokens (${finalUsage.toFixed(1)}%) | ${(elapsedMs / 1000).toFixed(1)}s`);

  const summary = createdFiles.length > 0
    ? `[Subagent done — ${createdFiles.length} file(s), ${turns} turns, ${finalTokens} tokens]\nFiles: ${createdFiles.join(', ')}${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`
    : `[Subagent done — no files, ${turns} turns, ${finalTokens} tokens]${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`;

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
