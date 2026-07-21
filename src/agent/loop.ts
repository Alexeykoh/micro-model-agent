import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ParsedToolCall } from '../tools/types.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { autoLearnFromError } from './memory.js';
import { appendNote, collectCodingStyle, loadProfile } from './user-profile.js';
import { ModeRegistry } from './modes/registry.js';
import { applyMode } from './modes/applier.js';
import { loadSkill, loadSkillsFromRefs, formatSkillsBlock, enforceSkillBudget } from '../skills/loader.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { isMCPCommand, parseMCPCommand, callMCPTool } from '../tools/mcp.js';
import { showPlan, getPlanPendingCount } from '../tools/plan.js';
import { listTodos } from '../tools/todo.js';
import { parseQuestionCommand } from '../tools/question.js';
import { parseApproveCommand } from '../tools/approve.js';
import { checkFileSyntax } from '../tools/syntax-check.js';
import { loadConfig, saveConfig, getLLMConfig } from '../config/config.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './system-prompt.js';
import { logInfo, logWarn, logError, logDebug, logLLMRequest, logLLMResponse, logToolCall, setStatusWriter, writeStatus } from '../logger.js';
import type { AgentMode } from '../config/types.js';
import { IsolatedLoopResult, buildSubagentContext, runIsolatedLoop, extractAllToolCalls, validateToolCall, doChat } from '../tools/subagent.js';
import { SubagentRenderer } from '../ui/subagent-renderer.js';
import { ToolExecutor } from './tool-executor.js';
import { planHandler } from '../tools/native/plan.js';
import { todoHandler } from '../tools/native/todo.js';
import { questionHandler } from '../tools/native/question.js';
import { approveHandler } from '../tools/native/approve.js';
import { userProfileHandler } from '../tools/native/user-profile.js';
import { themeHandler } from '../tools/native/theme.js';
import { bashHandler } from '../tools/bash.js';
import { readFileHandler } from '../tools/fs/read-file.js';
import { writeFileHandler } from '../tools/fs/write-file.js';
import { editFileHandler } from '../tools/fs/edit-file.js';
import { listDirHandler } from '../tools/fs/list-dir.js';
import { createDirHandler } from '../tools/fs/create-dir.js';
import { deleteFileHandler } from '../tools/fs/delete-file.js';
import { copyFileHandler } from '../tools/fs/copy-file.js';
import { moveFileHandler } from '../tools/fs/move-file.js';
import { fileInfoHandler } from '../tools/fs/file-info.js';
import { globSearchHandler } from '../tools/fs/glob-search.js';
import { grepSearchHandler } from '../tools/fs/grep-search.js';
import { treeHandler } from '../tools/fs/tree.js';
import { webSearchHandler } from '../tools/web-search.js';
import { webFetchHandler } from '../tools/web-fetch.js';

/**
 * Умная обрезка tool-результатов для экономии токенов в контексте.
 *
 * Полные результаты сохраняются в файл сессии, в контексте — только
 * достаточно информации для модели чтобы продолжить работу.
 *
 * Лимиты подобраны эмпирически: достаточно для маленьких моделей
 * понять что произошло, но не занимают весь контекст.
 */
function truncateToolOutput(toolName: string, output: string, exitCode: number): string {
  // Ошибки обрезаем мягче — модели нужен контекст для диагностики
  if (exitCode !== 0) {
    return output.length > 3000 ? output.slice(0, 3000) + '\n...[truncated]' : output;
  }

  // Лимиты для успешных операций (в символах)
  const LIMITS: Record<string, number> = {
    read_file: 2000,    // модель может ссылаться на строки
    write_file: 200,    // достаточно "Written X bytes"
    edit_file: 300,     // нужно знать что изменилось
    bash: 1500,         // build output, git status
    list_dir: 1500,     // структура обычно компактна
    glob_search: 1000,  // список файлов
    grep_search: 1500,  // результаты поиска
    tree: 1500,         // дерево файлов
    subagent: 500,      // краткое резюме от субагента
    web_search: 1000,   // результаты поиска
    web_fetch: 1500,    // контент страницы
  };

  const limit = LIMITS[toolName] ?? 800;
  if (output.length <= limit) return output;
  return output.slice(0, limit) + '\n...[truncated]';
}

/**
 * Основной цикл ReAct-агента.
 *
 * Архитектура цикла:
 * 1. Сборка system prompt (кэшируется на время сессии)
 * 2. Отправка запроса к LLM с историей сообщений
 * 3. Парсинг tool calls из ответа модели (формат <tool_call>)
 * 4. Валидация и исполнение каждого tool call
 * 5. Добавление результата в историю
 * 6. Повтор до завершения (нет tool calls) или лимита ходов
 *
 * Особенности:
 * - Fallback-парсинг при невалидном JSON от маленьких моделей
 * - Автоматическое компактирование контекста при приближении к лимиту
 * - Retry с увеличением temperature при пустых ответах
 * - Автодобавление скилов при обнаружении релевантных паттернов
 *
 * @module agent/loop
 */

/**
 * Fallback-извлечение bash-команды из ответа модели.
 * Используется когда основной парсинг tool calls не сработал
 * (маленькие модели часто генерируют невалидный JSON).
 * Применяет три regex-паттерна для поиска команды bash.
 */
function extractToolCallFallback(response: string): { name: string; cmd: string } | null {
  const patterns = [
    /"name"\s*:\s*"bash"\s*,\s*"arguments"\s*:\s*\{\s*"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    /name['"]\s*:\s*['"]bash['"]\s*,.*?cmd['"]\s*:\s*['"]((?:[^'\\]|\\.)*)['"]/,
  ];

  for (const re of patterns) {
    const m = response.match(re);
    if (m) {
      let cmd = m[1];
      cmd = cmd.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return { name: 'bash', cmd };
    }
  }
  return null;
}

/**
 * Результат выполнения цикла агента.
 * Содержит всю историю сообщений и опциональный pending-вопрос
 * (если агент вызвал инструмент question и ждёт ответа пользователя).
 */
export interface AgentLoopResult {
  messages: ChatMessage[];
  questionPending?: { question: string; choices?: string[] };
}

/**
 * Запускает основной цикл ReAct-агента.
 *
 * Цикл работает до тех пор, пока:
 * - Агент не перестанет вызывать инструменты (финальный текстовый ответ)
 * - Не будет достигнут лимит ходов (maxSteps из конфига)
 * - Пользователь не прервёт выполнение (abort signal)
 *
 * Стратегия обработки ошибок:
 * - Пустые ответы: retry до 3 раз с подсказкой "Continue."
 * - Невалидные tool calls: отправка обратной связи модели
 * - Пустые ответы подряд >3: остановка цикла
 *
 * @param provider - провайдер LLM (OpenAI-совместимый)
 * @param registry - реестр доступных инструментов
 * @param prompt - начальный промпт пользователя
 * @param contextManager - менеджер контекста (опциональный, создаётся новый если не передан)
 * @param previousMessages - предыдущие сообщения для восстановления сессии
 * @param renderer - рендерер вывода (Ink или readline)
 * @param providerName - имя провайдера для отображения
 * @param options - дополнительные опции (quiet, showThinking, mode)
 */
export async function runAgentLoop(
  provider: LLMProvider,
  registry: ToolRegistry,
  prompt: string,
  contextManager?: ContextManager,
  previousMessages?: ChatMessage[],
  renderer?: OutputRenderer,
  providerName?: string,
  options?: { quiet?: boolean; showThinking?: boolean; mode?: AgentMode },
): Promise<AgentLoopResult> {
  logInfo('LOOP', `runAgentLoop started: "${prompt.slice(0, 50)}"`);
  renderer?.resetAbort?.();
  // Парсинг ссылок на файлы в промпте (формат @path/to/file)
  const { prompt: enrichedPrompt, files } = await parseFileRefs(prompt);
  logDebug('LOOP', `parseFileRefs: ${files.length} files, prompt len: ${enrichedPrompt.length}`);
  const quiet = options?.quiet ?? false;

  // ─── ModeRegistry: конфигурация режима ──
  const modeRegistry = new ModeRegistry();
  const modeConfig = modeRegistry.getOrFallback(options?.mode || 'base');
  const applied = applyMode(modeConfig, { quiet, showThinking: options?.showThinking });

  // Автозагрузка скилов из промпта (если пользователь указал @skill-name)
  const loadedSkills = loadSkillsFromRefs(prompt, process.cwd());
  const loadedSkillNames = new Set(loadedSkills.map(s => s.name));
  if (loadedSkills.length > 0) {
    logInfo('LOOP', `loaded ${loadedSkills.length} skills: ${loadedSkills.map(s => s.name).join(', ')}`);
    renderer?.writeInfo(`  Loaded ${loadedSkills.length} skill(s): ${loadedSkills.map(s => s.name).join(', ')}`);
  }

  // Принудительная загрузка скилов из ModeConfig
  for (const skillName of applied.forcedSkills) {
    if (!loadedSkillNames.has(skillName)) {
      const skill = loadSkill(skillName, process.cwd());
      if (skill) {
        loadedSkills.push(skill);
        loadedSkillNames.add(skillName);
        logInfo('LOOP', `auto-loaded ${skillName} skill for ${modeConfig.id} mode`);
        renderer?.writeInfo(`  Auto-loaded @${skillName} skill for ${modeConfig.id} mode`);
      } else {
        logWarn('LOOP', `${skillName} skill not found for ${modeConfig.id} mode`);
        renderer?.writeWarning(`  Warning: @${skillName} skill not found (required for ${modeConfig.id} mode)`);
      }
    }
  }

  // Ограничение количества скилов в base mode
  const config = loadConfig();
  const maxSkills = options?.mode === 'pro'
    ? (config.agent.maxSkillsPro ?? 0)
    : (config.agent.maxSkillsBase ?? 2);

  if (maxSkills > 0 && loadedSkills.length > maxSkills) {
    const budget = applied.skillTokenBudget;
    const { allowed, dropped } = enforceSkillBudget(loadedSkills, budget);
    if (dropped.length > 0) {
      renderer?.writeWarning(`  Skill limit (${maxSkills} max in ${modeConfig.id} mode): dropped ${dropped.join(', ')}`);
      logInfo('LOOP', `skill limit: dropped ${dropped.join(', ')} (budget: ${budget} tokens)`);
      loadedSkills.length = 0;
      loadedSkills.push(...allowed);
      for (const s of dropped) loadedSkillNames.delete(s);
    }
  }

  if (files.length > 0) {
    const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
    const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
    logInfo('LOOP', `loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`);
    renderer?.writeInfo(`  Loaded ${files.length} files (${totalLines} lines, ~${totalTokens} tokens)`);
  }

  setStatusWriter(renderer ? (msg) => renderer.writeDim(`  ${msg}`) : null);
  writeStatus('Initializing...');
  // Сборка system prompt (включает инструкции, информацию о проекте, скилы, память)
  const sysStart = performance.now();
  const systemPrompt = buildSystemPrompt(loadedSkills.length > 0 ? loadedSkills : undefined, options?.mode);
  const sysElapsed = ((performance.now() - sysStart) / 1000).toFixed(1);
  writeStatus(`Done (${sysElapsed}s)`);
  setStatusWriter(null);

  // Начальное состояние истории: system prompt + предыдущие сообщения + текущий промпт
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(previousMessages || []),
    { role: 'user', content: enrichedPrompt },
  ];

  const ctx = contextManager ?? new ContextManager(provider.contextWindow);
  const maxSteps = config.agent.maxSteps ?? 100;
  let consecutiveEmpty = 0; // счётчик пустых ответов подряд
  let pendingSyntaxError = '';
  let aborted = false;
  let continuationNudges = 0; // счётчик подсказок "продолжай работать"
  let directWriteStreak = 0; // количество прямых write_file без subagent

  // ─── ToolExecutor: единый диспетчер инструментов ──
  const toolExecutor = new ToolExecutor();
  toolExecutor.registerAll([
    planHandler, todoHandler, questionHandler, approveHandler,
    userProfileHandler, themeHandler, bashHandler,
    readFileHandler, writeFileHandler, editFileHandler, listDirHandler,
    createDirHandler, deleteFileHandler, copyFileHandler, moveFileHandler,
    fileInfoHandler, globSearchHandler, grepSearchHandler, treeHandler,
    webSearchHandler, webFetchHandler,
  ]);

  // Reset abort signal for this run
  if (renderer?.abortSignal === undefined) {
    // Renderer doesn't support abort — fine
  }

  renderer?.updateStatus({
    provider: providerName,
    model: provider.model,
    contextWindow: provider.contextWindow,
    step: 0,
    maxSteps,
  });

  // ─── Основной цикл ReAct ────────────────────────────────
  for (let step = 0; step < maxSteps; step++) {
    if (renderer?.abortSignal?.aborted) {
      aborted = true;
      break;
    }
    let skillsAutoLoaded = false;
    const createdFiles: string[] = []; // отслеживание созданных/изменённых файлов

    logDebug('LOOP', `step ${step + 1}/${maxSteps} starting, ${messages.length} messages`);
    // Инкрементальный подсчёт — считаем только новые сообщения (быстрее в ~100x на больших историях)
    if (step === 0) {
      await ctx.updateTokens(messages);
    } else {
      await ctx.updateTokensIncremental(messages);
    }
    const skillNames = loadedSkills.map(s => s.name).join(', ');
    const usageText = ctx.formatUsage() + (skillNames ? ` │ skills: ${skillNames}` : '');
    renderer?.updateContextUsage(usageText);

    renderer?.updateStatus({
      provider: providerName,
      model: provider.model,
      tokens: ctx.totalTokens,
      contextWindow: provider.contextWindow,
      step: step + 1,
      maxSteps,
    });

    // ─── Compaction контекста ─────────────────────────────
    // Если использование контекста превышает порог (70%), компактируем историю
    if (ctx.needsCompact && messages.length > 6) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.compact(messages));
      if (!quiet) {
        renderer?.writeBracketTag('compact', `${before} → ${messages.length} messages`);
      }
      await ctx.updateTokens(messages);
    }

    // ─── Emergency compact при переполнении контекста ─────
    if (ctx.isOverflow) {
      const before = messages.length;
      messages.splice(0, messages.length, ...ctx.emergencyCompact(messages));
      if (!quiet) {
        renderer?.writeBracketTag('compact', `EMERGENCY: ${before} → ${messages.length}`);
      }
      await ctx.updateTokens(messages);
    }

    // ─── Запрос к LLM ────────────────────────────────────
    const llmCfg = getLLMConfig(config);
    logInfo('LOOP', `calling doChat, messages: ${messages.length}, options.showThinking: ${options?.showThinking}, retries: ${llmCfg.retries}`);
    const { response } = await doChat(provider, messages, renderer!, renderer?.abortSignal, llmCfg.retries, options?.showThinking);

    // Проверка прерывания во время генерации
    if (renderer?.abortSignal?.aborted) {
      aborted = true;
      break;
    }

    // ─── Автозагрузка скилов по @упоминаниям ─────────────
    // Если ответ содержит @skill-name, загружаем скил и пересобираем system prompt
    if (options?.mode !== 'fast' && !skillsAutoLoaded) {
    const suggestedSkillRefs = response.matchAll(/@(\w[\w-]*)/g);
    const newSkillNames: string[] = [];
    for (const match of suggestedSkillRefs) {
      const name = match[1];
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
      renderer?.writeInfo(`  Auto-loaded ${newSkillNames.length} skill(s): ${newSkillNames.join(', ')}`);
      messages[0] = { role: 'system', content: buildSystemPrompt(loadedSkills, options?.mode) };
      messages.push({ role: 'system', content: `Skills loaded: ${newSkillNames.join(', ')}. Continue your work using these skills where relevant.` });
      continue;
    }
    } // end fast-mode skill block

    // ─── Обработка пустых ответов ────────────────────────
    // Маленькие модели иногда возвращают пустой ответ — повторяем с подсказкой
    if (!response.trim()) {
      logWarn('LOOP', `empty response #${consecutiveEmpty + 1}`);
      consecutiveEmpty++;

      // После компактинга — более информативное сообщение о пустом ответе
      if (ctx.compactCount > 0 && consecutiveEmpty <= 3) {
        let lastUserMsg: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') { lastUserMsg = messages[i]; break; }
        }
        const contextHint = lastUserMsg
          ? `[System: You returned an empty response. The conversation was compressed. Continue working on: "${(lastUserMsg.content || '').slice(0, 150)}..."]`
          : '[System: You returned an empty response. Continue with the task.]';
        messages.push({ role: 'user', content: contextHint });
        if (!quiet) {
          renderer?.writeDim(`  [empty response, retrying with context hint]`);
        }
        continue;
      }

      const lastMsg = messages[messages.length - 1];
      if ((lastMsg?.role === 'user' || lastMsg?.role === 'system') && consecutiveEmpty <= 2) {
        // После system-сообщений (например "Skills loaded") — более конкретная подсказка
        const isAfterSystem = lastMsg?.role === 'system';
        const hint = isAfterSystem
          ? '[System: You returned an empty response. The skills are loaded. Now create a plan and start working on the task. Do NOT wait for further instructions.]'
          : 'Continue.';
        messages.push({ role: 'user', content: hint });
        if (!quiet) {
          renderer?.writeDim(`  [empty response, retrying${isAfterSystem ? ' with skills hint' : ''}]`);
        }
        continue;
      }
      renderer?.writeError(consecutiveEmpty > 3
        ? `[model returned empty response ${consecutiveEmpty} times in a row — stopping]`
        : '[model returned empty response]');
      return { messages };
    }
    consecutiveEmpty = 0;

    messages.push({ role: 'assistant', content: response });

    // ─── Парсинг tool calls ─────────────────────────────
    // Извлекаем JSON из тегов <tool_call>...</tool_call> и валидируем
    const allJsonRaw = extractAllToolCalls(response);

    const validCalls: { parsed: any; cmd?: string }[] = [];
    const invalidCalls: string[] = [];
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
        } else if (v.error) {
          invalidCalls.push(v.error);
        }
      }
    }

    // ─── Fallback: regex-извлечение при невалидном JSON ───
    if (validCalls.length === 0) {
      const fallback = extractToolCallFallback(response);
      if (fallback) {
        validCalls.push({ parsed: { name: 'bash', arguments: { cmd: fallback.cmd } }, cmd: fallback.cmd });
        if (!quiet) {
          renderer?.writeBracketTag('fallback', 'regex extracted command');
        }
      }
    }

    if (validCalls.length === 0) {
      if (invalidCalls.length > 0) {
        // If the response has substantial text outside tool_call tags,
        // it's a description with examples — not a failed tool call attempt.
        const textOutside = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        if (textOutside.length < 100) {
          const feedback = `[Tool call error(s)]\n${invalidCalls.join('\n')}\n\nFix the tool call format and try again. Use ONLY valid tool names: bash, read_file, write_file, edit_file, list_dir, create_dir, delete_file, copy_file, move_file, file_info, glob_search, grep_search, tree, web_search, web_fetch, plan, todo, question, approve, subagent.`;
          if (!quiet) {
            renderer?.writeError(`  [invalid tool call: ${invalidCalls[0]}]`);
          }
          messages.push({ role: 'tool', content: feedback, tool_call_id: `invalid-${Date.now()}` });
          continue;
        }
        // Text response with example tool calls — just log and proceed
        logWarn('LOOP', `ignored ${invalidCalls.length} invalid tool call(s) in descriptive text`);
      }

      // Nudge model to continue working after a tool result — but only if
      // the agent didn't already write a meaningful text response.
      if (continuationNudges < 2) {
        const lastThree = messages.slice(-3);
        const hasRecentToolResult = lastThree.some(m => m.role === 'tool');
        const alreadyResponded = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim().length > 20;
        if (hasRecentToolResult && !alreadyResponded) {
          continuationNudges++;
          if (!quiet) {
            renderer?.writeDim(`  [nudge ${continuationNudges}/2: continue working]`);
          }
          messages.push({ role: 'user', content: '[Tool result received. Write a response to the user. Do NOT call additional tools unless there is actual work to do.]' });
          continue;
        }
      }

      if (!skillsAutoLoaded) {
        const textOutside = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        const looksLikeDone = /done|готово|создан|выполн|completed|finished/i.test(textOutside);

        // Проверка: план с незавершёнными шагами — не даём агенту остановиться
        const pendingSteps = getPlanPendingCount();
        if (pendingSteps > 0 && looksLikeDone) {
          const planText = showPlan();
          const pendingList = planText.split('\n').filter(l => l.includes('○') || l.includes('►')).join('\n');
          if (!quiet) {
            renderer?.writeWarning(`  [plan has ${pendingSteps} incomplete steps — pushing agent to continue]`);
          }
          messages.push({
            role: 'user',
            content: `Plan is NOT complete! ${pendingSteps} step(s) remaining:\n${pendingList}\n\nContinue with the next step. Do NOT stop until all plan steps are done.`,
          });
          continuationNudges = 0;
          continue;
        }

        // Если модель claim-ит done но есть созданные файлы — напоминаем о полноте
        if (createdFiles.length > 0 && looksLikeDone) {
          messages.push({
            role: 'user',
            content: `Files created: ${createdFiles.join(', ')}. Before finishing — verify all files are complete and connected to each other. If any file is missing or not imported, continue working.`,
          });
          continuationNudges = 0;
          continue;
        }
        return { messages };
      }
      continue;
    }

    // ─── Enforce: лимиты на запись файлов ────────────────
    // Отслеживание повторных чтений одного файла для консолидации
    let lastReadFile: { path: string; offset: number; limit: number; content: string; toolId: string } | null = null;

    // Блокировка прямых write_file когда есть план с 3+ шагами —.force subagent
    const planSteps = showPlan();
    const hasMultiStepPlan = !planSteps.startsWith('No active plan') && (planSteps.match(/\n/g) || []).length >= 3;
    if (hasMultiStepPlan) {
      const directWrites = validCalls.filter(c => c.parsed.name === 'write_file' || c.parsed.name === 'edit_file');
      const hasSubagent = validCalls.some(c => c.parsed.name === 'subagent');
      if (directWrites.length > 0 && !hasSubagent) {
        // Block direct writes — model must use subagent
        for (const wc of directWrites) {
          const idx = validCalls.indexOf(wc);
          if (idx !== -1) validCalls.splice(idx, 1);
          const blockId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;
          messages.push({
            role: 'tool',
            content: `BLOCKED: You have a plan with multiple steps. Use subagent tool instead of write_file. Example: subagent("Create file X. Context: Y already exists.") Each subagent gets fresh context and works independently.`,
            tool_call_id: blockId,
          });
        }
        if (!quiet) {
          renderer?.writeWarning(`  [blocked ${directWrites.length} direct writes — use subagent for multi-step plans]`);
        }
      }
    }

    // ESCALATION: block write_file when creating 3+ files without subagent (no plan case)
    if (!hasMultiStepPlan) {
      const hasWrite = validCalls.some(c => c.parsed.name === 'write_file');
      const hasSubagentNow = validCalls.some(c => c.parsed.name === 'subagent');
      if (hasSubagentNow) {
        directWriteStreak = 0;
      } else if (hasWrite) {
        const writeCount = validCalls.filter(c => c.parsed.name === 'write_file').length;
        directWriteStreak += writeCount;
        if (directWriteStreak >= 3) {
          const directWrites = validCalls.filter(c => c.parsed.name === 'write_file');
          // Блокируем ВСЕ write_file, но отправляем ОДИН блокирующий message
          // чтобы не засорять контекст повторными BLOCKED
          for (const wc of directWrites) {
            const idx = validCalls.indexOf(wc);
            if (idx !== -1) validCalls.splice(idx, 1);
          }
          if (directWrites.length > 0) {
            const blockId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;
            messages.push({
              role: 'tool',
              content: `BLOCKED: You're creating file #${directWriteStreak} without subagent. For 3+ new files, use subagent for each one. Example: subagent("Create file X. Context: Y already exists.")`,
              tool_call_id: blockId,
            });
          }
          if (!quiet) {
            renderer?.writeWarning(`  [blocked ${directWrites.length} writes: ${directWriteStreak} files without subagent — use subagent for multi-file projects]`);
          }
        }
      } else {
        // Non-write tool calls don't reset the counter but also don't increment
        const hasNonWriteTool = validCalls.length > 0 && !hasWrite;
        if (hasNonWriteTool && directWriteStreak > 0) {
          // New file creations should not be penalized across different operation types
        }
      }
    }

    // Блокировка нескольких записей файлов за один ответ — максимум одна
    const writeCalls = validCalls.filter(c => c.parsed.name === 'write_file' || c.parsed.name === 'edit_file');
    if (writeCalls.length > 1) {
      // Keep only the first write call, block the rest
      const blocked = writeCalls.slice(1);
      validCalls.splice(validCalls.indexOf(blocked[0]), blocked.length);
      for (const bc of blocked) {
        const blockId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;
        messages.push({
          role: 'tool',
          content: `BLOCKED: Only one file write per response is allowed. You wrote ${writeCalls.length} files at once. Complete the first file, then write the next one.`,
          tool_call_id: blockId,
        });
      }
      if (!quiet) {
        renderer?.writeWarning(`  [blocked ${blocked.length} extra file writes — one at a time]`);
      }
    }

    // ─── Исполнение tool calls ──────────────────────────
    for (const call of validCalls) {
      const { parsed, cmd } = call;
      const isBash = parsed.name === 'bash';
      const preview = isBash
        ? (cmd!.length > 200 ? cmd!.slice(0, 200) + '...' : cmd!)
        : JSON.stringify(parsed.arguments);
      const toolId = `call-${Date.now()}-${step}-${Math.random().toString(36).slice(2, 6)}`;

      logToolCall(parsed.name, preview);

      if (!quiet) {
        renderer?.writeToolHeader(parsed.name);
        renderer?.writeToolPreview(parsed.name, preview);
      }

      const hookCmd = isBash ? cmd! : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
      const preHook = runPreToolUseHooks(process.cwd(), parsed.name, hookCmd);
      if (!preHook.continue) {
        if (!quiet) {
          renderer?.writeBracketTag('hook blocked', preHook.message || '');
        }
        messages.push({ role: 'tool', content: `Hook blocked: ${preHook.message || ''}`, tool_call_id: toolId });
        continue;
      }

      if (pendingSyntaxError && !isBash) {
        const isWriteOp = parsed.name === 'write_file' || parsed.name === 'edit_file';
        const newPath = String(parsed.arguments.path ?? '');
        // Allow editing config files (tsconfig.json, package.json) since they
        // can fix syntax errors (e.g. missing jsx flag in tsconfig)
        const isConfig = newPath === 'tsconfig.json' || newPath === 'package.json';
        if (isWriteOp && newPath !== pendingSyntaxError && !isConfig) {
          const blocked = `BLOCKED: You have a syntax error in ${pendingSyntaxError}. Fix it first before writing new files. If the error is about jsx, module resolution, or missing types — edit tsconfig.json (it is exempt from this block).`;
          if (!quiet) {
            renderer?.writeError(`  [blocked: fix syntax error in ${pendingSyntaxError} first]`);
          }
          messages.push({ role: 'tool', content: blocked, tool_call_id: toolId });
          continue;
        }
      }

      let toolOutput = '';
      let toolExitCode = 0;
      const toolStart = performance.now();

      // ─── Субагент: изолированный контекст для задачи ──
      if (parsed.name === 'subagent') {
        const task = String(parsed.arguments.task || '');
        if (!task) {
          toolOutput = 'Error: task is required';
          toolExitCode = 1;
        } else {
          const autoContext = buildSubagentContext(process.cwd());
          logInfo('AGENT', `spawning subagent | task: "${task.slice(0, 150)}"`);
          const subRenderer = new SubagentRenderer();
          try {
            const childResult = await runIsolatedLoop(
              provider, registry, task, autoContext, process.cwd(), quiet, subRenderer, toolExecutor
            );
            toolOutput = childResult.summary;
            logInfo('AGENT', `subagent returned | files: ${childResult.createdFiles.length} | turns: ${childResult.turns} | errors: ${childResult.errors.length}`);
            if (childResult.createdFiles.length > 0) {
              for (const f of childResult.createdFiles) {
                if (!createdFiles.includes(f)) createdFiles.push(f);
              }
            }
            const buf = subRenderer.getBuffer();
            if (!quiet && renderer?.writeToolBuffer) {
              renderer.writeToolBuffer({ lines: buf.lines, toolCalls: buf.toolCalls });
            }
          } catch (e: any) {
            toolOutput = `Subagent error: ${e.message}`;
            toolExitCode = 1;
            logError('AGENT', `subagent error: ${e.message}`);
          }
        }
        const subTime = ((performance.now() - toolStart) / 1000).toFixed(1);
        if (!quiet) {
          renderer?.writeToolResult(subTime, toolExitCode, toolOutput.slice(0, 300));
        }
      // ─── MCP: внешние tool-серверы ────────────────────────
      } else if (isBash && isMCPCommand(cmd!)) {
        const mcpCmd = parseMCPCommand(cmd!);
        if (mcpCmd) {
          if (!quiet) {
            renderer?.writeBracketTag('mcp', `${mcpCmd.server}/${mcpCmd.tool}`);
          }
          toolOutput = callMCPTool(process.cwd(), mcpCmd.server, mcpCmd.tool, mcpCmd.args);
        } else {
          toolOutput = 'Invalid MCP command. Format: mcp <server> <tool> [args_json]';
          toolExitCode = 1;
        }
      // ─── Все инструменты через ToolExecutor ──────────────
      } else {
        // Определяем инструмент и аргументы для executor'а
        let executorName = parsed.name;
        let executorArgs = parsed.arguments;

        // Bash-команды
        if (isBash) {
          executorName = 'bash';
          executorArgs = { cmd, timeout: parsed.arguments?.timeout ?? 120 };
        }

        const hookCmd = isBash ? cmd! : `${parsed.name} ${JSON.stringify(parsed.arguments)}`;
        const executorCall: ParsedToolCall = { id: toolId, name: executorName, arguments: executorArgs };
        const toolCtx = { cwd: process.cwd(), renderer, quiet };
        const { result, elapsed } = await toolExecutor.execute(executorCall, toolCtx, hookCmd);

        toolOutput = result.stdout || result.stderr || '(no output)';
        toolExitCode = result.exitCode;

        // Обработка question/approve: приостанавливаем цикл
        if (result.questionPending) {
          messages.push({
            role: 'tool',
            content: toolOutput,
            tool_call_id: toolId,
          });
          return {
            messages,
            questionPending: { question: toolOutput, choices: undefined },
          };
        }
      }


      const toolTime = ((performance.now() - toolStart) / 1000).toFixed(1);
      logToolCall(parsed.name, preview, toolExitCode !== 0 ? `exit:${toolExitCode} ${toolOutput.slice(0, 100)}` : `ok (${toolTime}s)`);
      if (toolExitCode !== 0) {
        const errText = toolOutput;
        if (!quiet) {
          for (const line of errText.split('\n').slice(0, 5)) {
            renderer?.writeError(`  ${line}`);
          }
        }
        autoLearnFromError(hookCmd, toolExitCode !== 0 ? toolOutput : '', '');
      }

      runPostToolUseHooks(process.cwd(), parsed.name, hookCmd, toolOutput, toolExitCode);

      // Track sequential read_file calls for consolidation
      if (!isBash && parsed.name === 'read_file' && toolExitCode === 0) {
        const filePath = String(parsed.arguments.path ?? '');
        const offset = Math.max(1, Number(parsed.arguments.offset ?? 1));
        const limit = Math.max(1, Number(parsed.arguments.limit ?? 500));

        if (lastReadFile && lastReadFile.path === filePath && offset === lastReadFile.offset + lastReadFile.limit) {
          // Sequential read — merge with previous result
          lastReadFile.content += '\n' + toolOutput;
          lastReadFile.offset = offset;
          lastReadFile.limit = limit;
          // Replace the last tool message content with merged content
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'tool' && messages[i].tool_call_id === lastReadFile.toolId) {
              messages[i].content = lastReadFile.content;
              break;
            }
          }
          // Remove the trailing "Continue." nudge + the new tool result that would be pushed
          while (messages.length > 0 && messages[messages.length - 1].role === 'user' && messages[messages.length - 1].content === 'Continue.') {
            messages.pop();
          }
          if (!quiet) {
            renderer?.writeBracketTag('consolidate', `merged read_file chunks for ${filePath}`);
          }
          continue; // skip pushing this result separately
        } else {
          // New file or non-sequential — start fresh
          lastReadFile = { path: filePath, offset, limit, content: toolOutput, toolId };
        }
      } else if (!isBash && parsed.name !== 'read_file') {
        lastReadFile = null;
      }

      // ─── Проверка синтаксиса после записи файлов ────────
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
            const { isAbsolute, relative } = await import('node:path');
            const filePath = isAbsolute(rawPath) ? relative(process.cwd(), rawPath).replace(/\\/g, '/') : rawPath;
            const syntaxResult = checkFileSyntax(filePath, process.cwd());
            if (syntaxResult !== 'OK') {
              const errorLines = syntaxResult.split('\n').filter(l => l.trim());
              const shown = errorLines.slice(0, 3);
              const extra = errorLines.length > 3 ? ` (+${errorLines.length - 3} more)` : '';
              if (!quiet) {
                renderer?.writeBracketTag('syntax', `${shown.join('; ')}${extra}`);
              }

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

              toolOutput = `SYNTAX ERROR in ${filePath}:\n${syntaxResult}${contextLines}`;

              // Detect config-related TS errors (missing jsx, module issues, etc.)
              const isConfigError = syntaxResult.includes('TS17004')
                || syntaxResult.includes('TS2307')
                || syntaxResult.includes('Cannot find module')
                || syntaxResult.includes('jsx')
                || syntaxResult.includes('moduleResolution');

              if (isConfigError) {
                toolOutput += `\n\nThis looks like a tsconfig.json configuration issue, NOT a code syntax error.\nCheck tsconfig.json — you may need to add "jsx": "react-jsx" or fix module settings.\nDo NOT modify the source code to work around config errors. Edit tsconfig.json instead.`;
              } else {
                toolOutput += `\n\nDo NOT rewrite the entire file. Use edit_file to fix the specific broken line:\n{"name":"edit_file","arguments":{"path":"${filePath}","old_string":"broken code here","new_string":"fixed code here"}}`;
              }

              hasSyntaxError = true;
              pendingSyntaxError = filePath;
            } else {
              if (pendingSyntaxError === filePath) {
                pendingSyntaxError = '';
              }
            }

            // Автодетекция стиля кодирования из содержимого файла
            if (toolExitCode === 0 && filePath) {
              try {
                const fullContent = readFileSync(join(process.cwd(), filePath), 'utf-8');
                collectCodingStyle(filePath, fullContent);
              } catch { /* ignore */ }
              // Track created/modified files for completion reporting
              if (!hasSyntaxError && !createdFiles.includes(filePath)) {
                createdFiles.push(filePath);
              }
            }
          }
        }
      }

      if (isBash && cmd!.startsWith('plan ') && toolExitCode === 0) {
        const planOutput = showPlan();
        if (planOutput && !planOutput.startsWith('No active plan')) {
          renderer?.writeLine(planOutput);
        }
      }

      if (isBash && cmd!.startsWith('todo ') && toolExitCode === 0) {
        const todoOutput = listTodos();
        if (todoOutput) {
          renderer?.writeLine(todoOutput);
        }
      }

      messages.push({
        role: 'tool',
        content: truncateToolOutput(parsed.name, toolOutput, toolExitCode),
        tool_call_id: toolId,
      });

      // НЕ добавляем "Continue." после каждого tool-вызова — это нарушает
      // структуру диалога. Bounded nudge (строка 418) уже покрывает
      // случай когда модель застряла без tool-вызова.

      if (hasSyntaxError) {
        break;
      }
    }
  }
  if (aborted) {
    renderer?.writeWarning('Agent stopped (double ESC)');
  }
  logInfo('LOOP', `runAgentLoop done: ${messages.length} total messages, aborted=${aborted}`);
  return { messages };
}
