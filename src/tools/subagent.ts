import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { LMStudioNative } from '../llm/lmstudio-native.js';
import { ToolRegistry } from './registry.js';
import type { ParsedToolCall } from './types.js';
import type { ToolExecutor } from '../agent/tool-executor.js';
import { ContextManager } from '../agent/context.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { checkFileSyntax } from './syntax-check.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { logInfo, logDebug, logWarn, logLLMRequest, logLLMResponse, logToolCall } from '../logger.js';
import { getLLMConfig } from '../config/config.js';

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

/**
 * Контекст для specialist'а — фокусированное описание ошибки.
 *
 * @param toolName - имя упавшего инструмента
 * @param toolArgs - аргументы которые были переданы
 * @param errorOutput - текст ошибки
 * @param userTask - исходный запрос пользователя (краткое описание)
 * @param attemptCount - сколько раз ошибка повторилась
 * @returns Текст задачи для specialist'а
 */
export function buildSpecialistTask(
  toolName: string,
  toolArgs: Record<string, unknown>,
  errorOutput: string,
  userTask: string,
  attemptCount: number,
): string {
  const argsStr = JSON.stringify(toolArgs, null, 2);
  return [
    `The tool "${toolName}" has failed ${attemptCount} times with the same error while working on: "${userTask.slice(0, 200)}"`,
    '',
    `Failed tool call:`,
    `  Tool: ${toolName}`,
    `  Arguments: ${argsStr}`,
    '',
    `Error output:`,
    `  ${errorOutput.slice(0, 500)}`,
    '',
    `Your task: Diagnose WHY this tool call fails and FIX the underlying problem.`,
    `  - Read the relevant files to understand the actual state`,
    `  - Fix the root cause (wrong path, missing file, syntax error, etc.)`,
    `  - If the tool call arguments are wrong, correct them`,
    `  - If the file doesn't exist, create it`,
    `  - Return a clear summary of what you found and what you fixed`,
  ].join('\n');
}

/** Паттерны ошибок которые НЕ триггерят specialist (trivial) */
const TRIVIAL_ERROR_PATTERNS = [
  /no results? found/i,
  /pattern .* matched 0 results/i,
  /0 files? matched/i,
  /command not found.*grep/i,
  /not a directory/i,
];

/** Паттерны ошибок которые ВСЕГДА требуют specialist (не trivial) */
const NON_TRIVIAL_ERROR_PATTERNS = [
  /unexpected token/i,
  /syntaxerror/i,
  /cannot find module/i,
  /module not found/i,
  /permission denied/i,
  /enoent/i,
  /eacces/i,
];

/**
 * Проверяет является ли ошибка тривиальной (не требует specialist).
 */
export function isTrivialError(toolName: string, errorOutput: string): boolean {
  // Синтаксические и критические ошибки — ВСЕГДА не trivial
  if (NON_TRIVIAL_ERROR_PATTERNS.some(p => p.test(errorOutput))) {
    return false;
  }

  // grep_search/glob_search с 0 результатами — нормальное поведение
  if (toolName === 'grep_search' || toolName === 'glob_search') {
    if (/0 results|0 files|no match/i.test(errorOutput) && errorOutput.length < 200) {
      return true;
    }
  }
  // Любая ошибка < 10 символов — скорее всего trivia
  if (errorOutput.length < 10) return true;

  return TRIVIAL_ERROR_PATTERNS.some(p => p.test(errorOutput));
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

  const VALID_TOOLS = new Set(['bash', 'plan', 'todo', 'question', 'approve', 'theme', 'user_profile', 'subagent', 'read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir', 'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search', 'grep_search', 'tree', 'web_search', 'web_fetch', 'scaffold', 'project_map']);

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
    question: ['question'],
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
  maxTokens?: number,
): Promise<{ response: string; genTimeMs: number }> {
  let lastReasoningText = '';

  // Phase 1: Normal attempts with thinking enabled
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;
    let reasoningBuf: string | false = false;
    let currentReasoning = ''; // накопленный reasoning текст для этого attempt
    let lastFinishReason: string | null = null;
    let reasoningChunksCount = 0;
    let contentChunksCount = 0;

    if (signal?.aborted) return { response: '', genTimeMs: 0 };

    const lastMsg = messages[messages.length - 1];
    logLLMRequest(provider.model, messages.length, lastMsg?.content || '', caller);

    if (caller === 'main') {
      renderer.setStreamRole?.('assistant');
    }

    renderer.writeSpinner();

    try {
      let buf = '';
      for await (const chunk of provider.chat(messages, { temperature: 0.7, signal, showThinking, enableThinking: true, max_tokens: maxTokens })) {
        if (!chunk.content && !chunk.reasoning && !chunk.finish_reason) continue;

        if (chunk.finish_reason) {
          lastFinishReason = chunk.finish_reason;
        }

        if (chunk.content) {
          fullText.push(chunk.content);
          contentChunksCount++;
        }

        if (chunk.reasoning) {
          reasoningChunksCount++;
          currentReasoning += chunk.reasoning;
        }

        if (!chunk.content && !chunk.reasoning) continue;

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

        if (reasoningBuf !== false && typeof reasoningBuf === 'string') {
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
      if (reasoningBuf !== false && typeof reasoningBuf === 'string') {
        renderer.writeNewline();
        renderer.writeDim(reasoningBuf);
      }
      // Сохраняем reasoning для fallback
      if (currentReasoning) {
        lastReasoningText = currentReasoning;
      }

    } catch (e: any) {
      if (e.name === 'AbortError') {
        logLLMResponse(provider.model, 0, performance.now() - startTime, 'Aborted', caller);
        return { response: '', genTimeMs: 0 };
      }
      logLLMResponse(provider.model, 0, performance.now() - startTime, e.message, caller);
      renderer.writeError(`\n[LLM] ${e.message}`);

      // Сетевые ошибки (fetch failed, ECONNREFUSED и т.д.) — retry с задержкой
      const isNetworkError = !e.message?.includes('API ') && !e.message?.includes('status');
      if (isNetworkError && attempt < retries) {
        const delay = Math.min(2000 * (attempt + 1), 10000);
        renderer.writeWarning(`[LLM] Network error, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

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

    // Диагностика пустого ответа
    const reason = lastFinishReason ?? 'unknown';
    logWarn('DOCHAT', `empty response #${attempt + 1}: finish_reason=${reason}, reasoning_chunks=${reasoningChunksCount}, content_chunks=${contentChunksCount}`);
    if (lastFinishReason === 'length') {
      renderer.writeWarning(`  [empty response: model hit max_tokens during reasoning (${reasoningChunksCount} reasoning chunks, 0 content chunks)]`);
    } else if (reasoningChunksCount > 0 && contentChunksCount === 0) {
      renderer.writeWarning(`  [empty response: model produced ${reasoningChunksCount} reasoning chunks but no content]`);
    }

    if (attempt < retries) {
      renderer.writeDim(`[retry ${attempt + 1}/${retries}]`);
    }
  }

  const llmCfg = getLLMConfig();

  // Phase 2: Retry WITHOUT thinking — модель генерирует content напрямую
  if (llmCfg.retryWithoutThinking && lastReasoningText.trim()) {
    logInfo('DOCHAT', `retrying without thinking (had ${lastReasoningText.length} reasoning chars)`);
    renderer.writeDim(`[retry without thinking]`);
    const retryResult = await doChatOnce(provider, messages, renderer, signal, false, showThinking, caller, maxTokens);
    if (retryResult.response.trim()) {
      logInfo('DOCHAT', `retry without thinking succeeded: ${retryResult.response.length} chars`);
      return retryResult;
    }
  }

  // Phase 2.5: Emergency — принудительно генерируем content с низкой температурой
  // Когда reasoning есть, но content пустой — модель "застряла" в thinking loop
  if (lastReasoningText.trim()) {
    logInfo('DOCHAT', `emergency: forcing content with low temperature`);
    renderer.writeDim(`[emergency: forcing content with temperature=0.1]`);
    const emergencyMessages: ChatMessage[] = [
      ...messages,
      { role: 'user', content: '[System] You MUST produce a response now. Do NOT use thinking tags. Reply with a tool call or a direct answer. Any response is better than empty.' },
    ];
    const emergencyResult = await doChatOnce(provider, emergencyMessages, renderer, signal, false, showThinking, caller, maxTokens, 0.1);
    if (emergencyResult.response.trim()) {
      logInfo('DOCHAT', `emergency succeeded: ${emergencyResult.response.length} chars`);
      return emergencyResult;
    }
  }

  // Phase 3: Fallback — используем reasoning как content
  if (llmCfg.fallbackToReasoning && lastReasoningText.trim()) {
    logInfo('DOCHAT', `fallback: using reasoning as content (${lastReasoningText.length} chars)`);
    renderer.writeWarning(`  [fallback: using reasoning as content]`);
    return { response: lastReasoningText, genTimeMs: 0 };
  }

  return { response: '', genTimeMs: 0 };
}

/**
 * Одиночный вызов LLM без retry логики.
 * Используется для retry с другими параметрами (например, enableThinking: false).
 */
async function doChatOnce(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  enableThinking = true,
  showThinking = false,
  caller: 'main' | 'subagent' = 'main',
  maxTokens?: number,
  temperature = 0.7,
): Promise<{ response: string; genTimeMs: number }> {
  const startTime = performance.now();
  const fullText: string[] = [];
  let started = false;

  if (signal?.aborted) return { response: '', genTimeMs: 0 };

  if (caller === 'main') {
    renderer.setStreamRole?.('assistant');
  }

  renderer.writeSpinner();

  try {
    let buf = '';
    for await (const chunk of provider.chat(messages, { temperature, signal, showThinking, enableThinking, max_tokens: maxTokens })) {
      if (!chunk.content && !chunk.finish_reason) continue;

      if (chunk.content) {
        fullText.push(chunk.content);
      }

      if (!chunk.content) continue;

      if (!started) {
        renderer.clearSpinner();
        started = true;
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
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { response: '', genTimeMs: 0 };
    }
    renderer.writeError(`\n[LLM] ${e.message}`);
    return { response: '', genTimeMs: 0 };
  }

  const genTimeMs = performance.now() - startTime;
  const response = fullText.join('');
  renderer.commitMarkdown();

  logLLMResponse(provider.model, response.length, genTimeMs, undefined, caller);
  return { response, genTimeMs };
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
  toolExecutor?: ToolExecutor,
  mode?: string,
  toolModel?: string,
  maxStepsParam?: number,
): Promise<IsolatedLoopResult> {
  const createdFiles: string[] = [];
  const errors: string[] = [];
  const startTime = performance.now();

  // Two-model pipeline: если toolModel задана, создаём отдельный провайдер
  let effectiveProvider = provider;
  if (toolModel && provider instanceof LMStudioNative) {
    effectiveProvider = new LMStudioNative(
      (provider as any).baseUrl,
      toolModel,
      provider.contextWindow,
    );
    logInfo('SUBAGENT', `using tool model: ${toolModel} (main: ${provider.model})`);
  }

  logInfo('SUBAGENT', `START | task: "${task.slice(0, 200)}" | context window: ${effectiveProvider.contextWindow}`);

  // Always build auto-context from project, even if model didn't pass existingFiles
  const autoContext = buildSubagentContext(cwd);
  const mergedContext = existingFiles
    ? existingFiles + '\n' + autoContext
    : autoContext;

  if (mergedContext) {
    logDebug('SUBAGENT', `context (${mergedContext.split('\n').length} lines):\n${mergedContext}`);
  }

  const systemPrompt = buildSystemPrompt(undefined, (mode || "base") as any);

  const contextInfo = mergedContext
    ? `\n\nКонтекст проекта:\n${mergedContext}\nПосмотри package.json для списка пакетов. Используй read_file для чтения существующих файлов.`
    : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task + contextInfo },
  ];

  const ctx = new ContextManager(effectiveProvider.contextWindow);
  const maxSteps = maxStepsParam ?? 20;
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

    // После tool call увеличиваем max_tokens чтобы модель успела сгенерировать контент после reasoning
    const hasToolResult = messages.some(m => m.role === 'tool');
    const llmCfg = getLLMConfig();
    const maxTokens = hasToolResult ? llmCfg.maxTokensAfterTool : undefined;

    const { response } = await doChat(effectiveProvider, messages, renderer!, renderer?.abortSignal, 1, false, 'subagent', maxTokens);

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

        const hookCmd = isBash ? String(cmd) : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
        const execResult = toolExecutor ? await toolExecutor.execute({ id: toolId, name: parsed.name, arguments: parsed.arguments } as any, { cwd, quiet: false }, hookCmd) : null;
        const result = execResult?.result ?? { stdout: '', stderr: 'ToolExecutor not available', exitCode: 1, truncated: false };
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

        const bashExecResult = toolExecutor ? await toolExecutor.execute({ id: toolId, name: 'bash', arguments: { cmd, timeout: parsed.arguments?.timeout ?? 30 } } as any, { cwd, quiet: false }, String(cmd)) : null;
        const result = bashExecResult?.result ?? { stdout: '', stderr: 'ToolExecutor not available', exitCode: 1, truncated: false };
        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;

        if (toolExitCode !== 0) {
          logDebug('SUBAGENT', `bash failed: exit ${toolExitCode} | ${toolOutput.slice(0, 200)}`);
          // Если bash падает из-за отсутствия shell —提示 модель использовать write_file
          if (/pwsh|powershell|not recognized|not found/i.test(toolOutput)) {
            toolOutput += '\n\n[HINT] Shell unavailable on this system. Use write_file tool to create files manually. Do NOT retry bash commands.';
          }
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

  // Собираем список использованных инструментов из истории
  const toolsUsed = [...new Set(
    messages
      .filter(m => m.role === 'assistant')
      .flatMap(m => {
        const calls = m.content.matchAll(/<tool_call>\{"name":"([^"]+)"/g);
        return [...calls].map(c => c[1]);
      })
  )];
  const toolsStr = toolsUsed.length > 0 ? `\nTools used: ${toolsUsed.join(', ')}` : '';

  const summary = createdFiles.length > 0
    ? `[Subagent done — ${createdFiles.length} file(s), ${turns} turns]\nFiles: ${createdFiles.join(', ')}${toolsStr}${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`
    : `[Subagent done — no files, ${turns} turns]${toolsStr}${errors.length > 0 ? `\nErrors: ${errors.join('; ')}` : ''}`;

  return { createdFiles, errors, summary, turns };
}

// ─── Tool definition ──────────────────────────────────────

import type { ToolDefinition } from './registry.js';

export const subagentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'subagent',
    description: 'Delegate a task to an isolated agent with a FRESH context (no history of prior errors). Use for: (1) each file when creating 3+ new files, (2) any task where you are stuck or making repeated errors, (3) simple single-step operations (bash, file read/write). The subagent has all tools and starts clean — ideal when accumulated context is causing confusion.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the subagent should do — be specific and include file paths' },
        existingFiles: { type: 'string', description: 'Comma-separated files the subagent can read for context (optional)' },
      },
      required: ['task'],
    },
  },
};
