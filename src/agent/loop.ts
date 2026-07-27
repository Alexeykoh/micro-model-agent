import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMProvider, ChatMessage } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { parseToolCalls } from '../tools/parse-tool-call.js';
import type { ParsedToolCall } from '../tools/types.js';
import { parseFileRefs } from '../file-loader.js';
import { ContextManager } from './context.js';
import { autoLearnFromError } from './memory.js';
import { appendNote, collectCodingStyle, loadProfile } from './user-profile.js';
import { ModeRegistry } from './modes/registry.js';
import { applyMode } from './modes/applier.js';
import { loadSkill, loadSkillsFromRefs, formatSkillsBlock, enforceSkillBudget, preloadSkillsByKeywords, isSkillRequest, listInstalledSkills } from '../skills/loader.js';
import { runPreToolUseHooks, runPostToolUseHooks } from '../tools/hooks.js';
import { isMCPCommand, parseMCPCommand, callMCPTool } from '../tools/mcp.js';
import { showPlan, getPlanPendingCount, clearPlan, getNextPendingStep, updatePlanStep, getPlanStepTitle, extractDirFromStepTitle } from '../tools/plan.js';

import { generateToolCallId } from '../tools/id-gen.js';
import { checkFileSyntax } from '../tools/syntax-check.js';
import { loadConfig, saveConfig, getLLMConfig, getSpecialistConfig, getGroundingConfig } from '../config/config.js';
import type { OutputRenderer } from '../ui/renderer.js';
import { buildSystemPrompt } from './system-prompt.js';
import { logInfo, logWarn, logError, logDebug, logLLMRequest, logLLMResponse, logToolCall, setStatusWriter, writeStatus } from '../logger.js';
import type { AgentMode } from '../config/types.js';
import { IsolatedLoopResult, buildSubagentContext, buildSpecialistTask, isTrivialError, runIsolatedLoop, doChat } from '../tools/subagent.js';
import { SubagentRenderer } from '../ui/subagent-renderer.js';
import { ToolExecutor } from './tool-executor.js';
import { PluginManager } from '../plugins/manager.js';
import { loadAllPluginsWithInfo } from '../plugins/loader.js';
import { handleToolAfter as lintHandleToolAfter } from '../plugins/builtin/lint-on-write/index.js';
import { handleAgentDone, handleToolBlocked, handleToolAfter as notifyHandleToolAfter } from '../plugins/builtin/notify/index.js';
import { planHandler } from '../tools/native/plan.js';
import { todoHandler } from '../tools/native/todo.js';
import { questionHandler } from '../tools/native/question.js';
import { approveHandler } from '../tools/native/approve.js';
import { userProfileHandler } from '../tools/native/user-profile.js';
import { themeHandler } from '../tools/native/theme.js';
import { scaffoldHandler } from '../tools/native/scaffold.js';
import { projectMapHandler } from '../tools/native/project-map.js';
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
import { webBrowseHandler } from '../tools/web-browse.js';

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
    web_browse: 2000,   // browser interaction results
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
 * Параметры для specialist'а — изолированного суб-агента,
 * который решает повторяющуюся ошибку инструмента.
 *
 * Собраны в один объект чтобы не передавать 15+ аргументов в функцию.
 */
interface SpecialistParams {
  provider: LLMProvider; registry: ToolRegistry; toolExecutor: ToolExecutor;
  modeConfig: any; llmCfg: any; specialistCfg: any;
  quiet: boolean; renderer: any; messages: ChatMessage[];
  toolId: string; createdFiles: string[];
  toolName: string; toolArgs: Record<string, unknown>;
  errorOutput: string; errorCount: number; enrichedPrompt: string;
}

/**
 * Запускает specialist'а для решения повторяющейся ошибки.
 *
 * Specialist — это изолированный суб-агент со свежим контекстом,
 * который получает задачу "диагностируй и исправь ошибку инструмента X".
 *
 * Алгоритм:
 * 1. Формирует задачу через buildSpecialistTask()
 * 2. Собирает контекст проекта через buildSubagentContext()
 * 3. Запускает runIsolatedLoop() с ограничением maxSteps
 * 4. Заменяет результат ошибки в messages[] на результат specialist'а
 * 5. Трекает созданные specialist'ом файлы
 *
 * @returns true если specialist отработал (основной цикл должен continue),
 *          false если specialist упал (ошибка остаётся в messages)
 */
async function spawnSpecialist(p: SpecialistParams): Promise<boolean> {
  if (!p.quiet) {
    p.renderer?.writeBracketTag('specialist', `solving '${p.errorOutput.slice(0, 60).replace(/\n/g, ' ')}' error...`);
  }
  const task = buildSpecialistTask(p.toolName, p.toolArgs, p.errorOutput, p.enrichedPrompt, p.errorCount);
  const ctx = buildSubagentContext(process.cwd());
  const sub = new SubagentRenderer();
  try {
    logInfo('LOOP', `spawning specialist for ${p.toolName} (attempt #${p.errorCount})`);
    const r = await runIsolatedLoop(
      p.provider, p.registry, task, ctx, process.cwd(),
      p.quiet, sub, p.toolExecutor, p.modeConfig.subagentMode, p.llmCfg.toolModel, p.specialistCfg.maxSteps,
    );
    for (let i = p.messages.length - 1; i >= 0; i--) {
      if (p.messages[i].role === 'tool' && p.messages[i].tool_call_id === p.toolId) {
        const text = r.errors.length > 0
          ? `[Specialist attempted to fix "${p.toolName}" but failed:\n${r.errors.join('\n')}\n${r.summary}]\nTry a different approach.`
          : `[Specialist resolved "${p.toolName}" error.\n${r.summary}]\nContinue with the task.`;
        p.messages[i].content = truncateToolOutput(p.toolName, text, 0);
        break;
      }
    }
    for (const f of r.createdFiles) { if (!p.createdFiles.includes(f)) p.createdFiles.push(f); }
    const buf = sub.getBuffer();
    if (!p.quiet && p.renderer?.writeToolBuffer) p.renderer.writeToolBuffer({ lines: buf.lines, toolCalls: buf.toolCalls });
    logInfo('LOOP', `specialist done | files: ${r.createdFiles.length} | turns: ${r.turns} | errors: ${r.errors.length}`);
    return true;
  } catch (e: any) {
    logError('LOOP', `specialist error: ${e.message}`);
    if (!p.quiet) p.renderer?.writeError(`  [specialist failed: ${e.message}]`);
    return false;
  }
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

  // ─── Behaviors из ModeConfig ──────────────────────────
  const behaviors = modeConfig.behaviors;
  const planEnforcement = behaviors.planEnforcement !== false;
  const directWriteStreakMax = typeof behaviors.directWriteStreakLimit === 'number'
    ? behaviors.directWriteStreakLimit : (behaviors.directWriteStreak !== false ? 3 : Infinity);
  const continuationNudgeMax = typeof behaviors.continuationNudgeLimit === 'number'
    ? behaviors.continuationNudgeLimit : (behaviors.continuationNudge !== false ? 2 : 0);
  const readConsolidation = behaviors.readConsolidation !== false;

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

  // Ограничение количества скилов из ModeConfig (не deprecated config)
  const config = loadConfig();
  const maxSkills = modeConfig.constraints.maxSkills;

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

  // Pre-load скиллов по ключевым словам (без language-specific хардкода)
  if (loadedSkills.length === 0 && options?.mode !== 'fast') {
    const keywordSkills = preloadSkillsByKeywords(prompt, process.cwd());
    for (const skill of keywordSkills) {
      if (!loadedSkillNames.has(skill.name)) {
        loadedSkills.push(skill);
        loadedSkillNames.add(skill.name);
        logInfo('LOOP', `keyword preloaded skill: ${skill.name}`);
        renderer?.writeInfo(`  Auto-loaded @${skill.name} (keyword match)`);
      }
    }

    // Если пользователь явно просит "используй скилл", но ничего не нашлось — подсказываем
    if (keywordSkills.length === 0 && isSkillRequest(prompt)) {
      const allSkills = listInstalledSkills(process.cwd());
      renderer?.writeWarning(`  You asked for a skill but none matched. Use @skill-name in your prompt to load one. Installed: ${allSkills.slice(0, 10).map(s => '@' + s).join(', ')}... (${allSkills.length} total)`);
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

  // ─── PluginManager: загрузка и активация плагинов ──
  const pluginManager = new PluginManager();
  const pluginLogger = { info: logInfo.bind(null, 'PLUGIN'), warn: logWarn.bind(null, 'PLUGIN'), error: logError.bind(null, 'PLUGIN'), debug: logDebug.bind(null, 'PLUGIN') };
  const pluginCtx = { cwd: process.cwd(), config: {}, logger: pluginLogger };

  // Загружаем все плагины (builtin + project + user)
  const pluginInfos = await loadAllPluginsWithInfo(pluginManager);

  // Активируем плагины из modeConfig (кастомные)
  if (modeConfig.plugins?.length) {
    await pluginManager.activateAll(modeConfig.plugins, pluginCtx);
  }

  // Авто-активация builtin плагинов (все моды)
  const builtinPlugins = pluginInfos.filter(p => p.source === 'builtin');
  for (const bp of builtinPlugins) {
    if (!pluginManager.isActive(bp.name)) {
      await pluginManager.activate(bp.name, pluginCtx);
    }
  }

  // Активация плагинов из config.agent.plugins
  const configPlugins = config.agent?.plugins || [];
  for (const pluginName of configPlugins) {
    if (!pluginManager.isActive(pluginName)) {
      await pluginManager.activate(pluginName, pluginCtx);
    }
  }

  // Регистрация обработчиков событий для всех активных плагинов
  if (pluginManager.isActive('lint-on-write')) {
    pluginManager.on('tool:after', 'lint-on-write', (toolName: string, args: any, result: any) => {
      return lintHandleToolAfter(toolName, args, result, process.cwd(), '.lint-detected');
    });
  }
  if (pluginManager.isActive('notify')) {
    pluginManager.on('agent:done', 'notify', () => handleAgentDone());
    pluginManager.on('tool:blocked', 'notify', (toolName: string, args: any) => handleToolBlocked(toolName, args));
    pluginManager.on('tool:after', 'notify', (toolName: string, args: any, result: any) => notifyHandleToolAfter(toolName, args, result));
  }

  const pluginSections = await pluginManager.getPromptSections();

  // Сборка system prompt (включает инструкции, информацию о проекте, скилы, память, плагины)
  const sysStart = performance.now();
  const systemPrompt = buildSystemPrompt(loadedSkills.length > 0 ? loadedSkills : undefined, options?.mode, pluginSections);
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
  let consecutiveMissingGrounding = 0; // счётчик пропущенных grounding-маркеров подряд
  let directWriteStreak = 0; // количество прямых write_file без subagent
  /** Трекер повторяющихся tool errors: { normalizedError → count } */
  const consecutiveToolErrors = new Map<string, number>();
  /** Общий счётчик ошибок за сессию */
  let totalToolErrors = 0;
  /** Стратегия обработки ошибок: 'normal' | 'subagent-hint' | 'force-subagent' */
  let errorStrategy: 'normal' | 'subagent-hint' | 'force-subagent' = 'normal';
  /** Флаг: specialist уже был запущен для текущей ошибки (чтобы не дублировать) */
  let specialistSpawnedFor: string | null = null;
  /** Счётчик бесполезных действий (list_dir, glob_search, todo list без результата) */
  let uselessActionCount = 0;
  /** История последних чтений файлов для.detect повторных чтений */
  const recentReadFiles: string[] = [];
  /** История последних grep-запросов для detect повторных поисков */
  const recentGrepPatterns: string[] = [];
  /** История последних вопросов для detect повторных вопросов */
  const recentQuestions: string[] = [];

  // ─── ToolExecutor: единый диспетчер инструментов ──
  const toolExecutor = new ToolExecutor();
  toolExecutor.setPluginManager(pluginManager);
  toolExecutor.registerAll([
    planHandler, todoHandler, questionHandler, approveHandler,
    userProfileHandler, themeHandler, scaffoldHandler, projectMapHandler, bashHandler,
    readFileHandler, writeFileHandler, editFileHandler, listDirHandler,
    createDirHandler, deleteFileHandler, copyFileHandler, moveFileHandler,
    fileInfoHandler, globSearchHandler, grepSearchHandler, treeHandler,
    webSearchHandler, webFetchHandler, webBrowseHandler,
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

      // Применяем бюджет скилов после автозагрузки (Баг 1 fix)
      const autoBudget = applied.skillTokenBudget;
      if (autoBudget > 0 && loadedSkills.length > 0) {
        const { allowed, dropped } = enforceSkillBudget(loadedSkills, autoBudget);
        if (dropped.length > 0) {
          renderer?.writeWarning(`  Auto-load budget: dropped ${dropped.join(', ')} (budget: ${autoBudget} tokens)`);
          logInfo('LOOP', `auto-load budget: dropped ${dropped.join(', ')} (budget: ${autoBudget} tokens)`);
          loadedSkills.length = 0;
          loadedSkills.push(...allowed);
          for (const s of dropped) loadedSkillNames.delete(s);
        }
      }

      renderer?.writeInfo(`  Auto-loaded ${loadedSkills.filter(s => newSkillNames.includes(s.name)).length} skill(s): ${newSkillNames.join(', ')}`);
      messages[0] = { role: 'system', content: buildSystemPrompt(loadedSkills, options?.mode, pluginSections) };
      // Не удаляем ответ ассистента — skills загружаются для следующих шагов цикла.
      // Модель увидит обновлённый system prompt на следующей итерации и сможет
      // использовать загруженные скилы без retry (экономит ~один LLM-запрос).
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

    const { validCalls, invalidCalls } = parseToolCalls(response);

    if (validCalls.length === 0) {
      if (invalidCalls.length > 0) {
        // If the response has substantial text outside tool_call tags,
        // it's a description with examples — not a failed tool call attempt.
        const textOutside = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        if (textOutside.length < 100) {
          const feedback = `[Tool call error(s)]\n${invalidCalls.join('\n')}\n\nFix the tool call format and try again. Use ONLY valid tool names: bash, read_file, write_file, edit_file, list_dir, create_dir, delete_file, copy_file, move_file, file_info, glob_search, grep_search, tree, web_search, web_fetch, web_browse, plan, todo, question, approve, subagent, scaffold.`;
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
      if (continuationNudgeMax > 0 && continuationNudges < continuationNudgeMax) {
        const lastThree = messages.slice(-3);
        const hasRecentToolResult = lastThree.some(m => m.role === 'tool');
        const alreadyResponded = response.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim().length > 20;
        if (hasRecentToolResult && !alreadyResponded) {
          continuationNudges++;
          if (!quiet) {
            renderer?.writeDim(`  [nudge ${continuationNudges}/${continuationNudgeMax}: continue working]`);
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
          const pendingLines = planText.split('\n').filter(l => l.includes('○') || l.includes('►'));
          const nextStep = pendingLines[0] || '';
          const nextStepMatch = nextStep.match(/\d+\.\s*(.+)/);
          const nextStepTitle = nextStepMatch ? nextStepMatch[1].trim() : '';
          if (!quiet) {
            renderer?.writeWarning(`  [plan has ${pendingSteps} incomplete steps — pushing agent to continue]`);
          }
          const nudge = nextStepTitle
            ? `Plan is NOT complete! ${pendingSteps} step(s) remaining.\nNext step: ${nextStepTitle}\nUse subagent to execute this step, then mark done: plan({action:"done", step:N})`
            : `Plan is NOT complete! ${pendingSteps} step(s) remaining:\n${pendingLines.join('\n')}\n\nContinue with the next step using subagent.`;
          messages.push({ role: 'user', content: nudge });
          continuationNudges = 0;
          continue;
        }

        // Phase 4.1: Аудит файлов при завершении плана
        if (pendingSteps === 0 && looksLikeDone) {
          const plan = showPlan();
          if (!plan.startsWith('No active plan')) {
            // Извлекаем заголовки шагов и проверяем наличие файлов
            const stepLines = plan.split('\n').filter(l => l.match(/\d+\.\s/));
            const missingFiles: string[] = [];
            for (const line of stepLines) {
              const titleMatch = line.match(/\d+\.\s*(.+)/);
              if (!titleMatch) continue;
              const title = titleMatch[1].trim();
              // Извлекаем имя файла из заголовка (паттерн: "Create file.ext" или "file.ext")
              const fileMatch = title.match(/(?:Create|Создать|Add|Добавить)\s+(\S+\.(?:ts|tsx|js|jsx|json|html|css|md|yaml|yml))/i)
                || title.match(/(\w+\.(?:ts|tsx|js|jsx|json|html|css|md|yaml|yml))/i);
              if (fileMatch) {
                const fileName = fileMatch[1];
                if (!existsSync(fileName) && !createdFiles.some(f => f.endsWith(fileName))) {
                  missingFiles.push(fileName);
                }
              }
            }
            if (missingFiles.length > 0) {
              if (!quiet) {
                renderer?.writeWarning(`  [plan complete but missing files: ${missingFiles.join(', ')}]`);
              }
              messages.push({
                role: 'user',
                content: `Plan claims all steps done, but these files are missing: ${missingFiles.join(', ')}. Create them before finishing.`,
              });
              continuationNudges = 0;
              continue;
            }
          }
        }

        // Stuck detection: если модель делает бесполезные действия
        const isUselessAction = validCalls.some(c =>
          c.parsed.name === 'list_dir' || c.parsed.name === 'tree' ||
          (c.parsed.name === 'todo' && c.parsed.arguments?.action === 'list') ||
          (c.parsed.name === 'question' && !c.parsed.arguments?.question)
        );

        // Phase 5.1: Расширенное detect — повторные чтения, поиски и вопросы
        let isRepeatedRead = false;
        let isRepeatedSearch = false;
        let isRepeatedQuestion = false;
        for (const c of validCalls) {
          if (c.parsed.name === 'read_file') {
            const filePath = String(c.parsed.arguments?.path || '');
            if (recentReadFiles.includes(filePath)) {
              isRepeatedRead = true;
            }
            recentReadFiles.push(filePath);
            if (recentReadFiles.length > 5) recentReadFiles.shift();
          }
          if (c.parsed.name === 'grep_search') {
            const pattern = String(c.parsed.arguments?.pattern || '');
            if (recentGrepPatterns.includes(pattern)) {
              isRepeatedSearch = true;
            }
            recentGrepPatterns.push(pattern);
            if (recentGrepPatterns.length > 5) recentGrepPatterns.shift();
          }
          if (c.parsed.name === 'question') {
            const questionText = String(c.parsed.arguments?.question || '');
            if (recentQuestions.includes(questionText)) {
              isRepeatedQuestion = true;
            }
            recentQuestions.push(questionText);
            if (recentQuestions.length > 3) recentQuestions.shift();
          }
        }

        const isStuckAction = isUselessAction || isRepeatedRead || isRepeatedSearch || isRepeatedQuestion;
        if (isStuckAction) {
          uselessActionCount++;
          if (uselessActionCount >= 3) {
            if (!quiet) {
              renderer?.writeWarning(`  [agent stuck: ${uselessActionCount} useless actions]`);
            }
            clearPlan();
            messages.push({
              role: 'user',
              content: `[System: You are stuck in a loop. STOP calling the same tool. The user already answered your question — use their answer and proceed with the task. Do NOT ask the same question again.]`,
            });
            uselessActionCount = 0;
            continuationNudges = 0;
            continue;
          }
        } else if (validCalls.some(c => c.parsed.name === 'subagent' || c.parsed.name === 'write_file' || c.parsed.name === 'bash')) {
          uselessActionCount = 0;
          recentReadFiles.length = 0;
          recentGrepPatterns.length = 0;
          recentQuestions.length = 0;
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

    // ─── Grounding check ────────────────────────────────
    // Проверка наличия маркера @grounding[файл: path] перед tool_call
    if (validCalls.length > 0) {
      const groundingCfg = getGroundingConfig(config);
      if (groundingCfg.enabled) {
        const groundMatches = Array.from(response.matchAll(/@grounding\[файл:\s*([^\]]+)\]/g));
        const groundPaths = groundMatches.map(m => m[1].trim());
        const pathCalls = validCalls.filter(c => c.parsed.arguments?.path);

        if (pathCalls.length > groundPaths.length) {
          consecutiveMissingGrounding++;
          const maxMissing = groundingCfg.maxMissingGrounding ?? 3;

          if (consecutiveMissingGrounding >= maxMissing) {
            if (!quiet) renderer?.writeError(`  [grounding: ${consecutiveMissingGrounding}/${maxMissing} missing markers]`);
            messages.push({
              role: 'user',
              content: `[Grounding Error: Missing @grounding[файл: path] marker before tool call. CRITICAL: Output the marker on its own line BEFORE every <tool_call>.]`,
            });
            continue;
          }

          if (groundingCfg.strictMode) {
            if (!quiet) renderer?.writeError(`  [grounding: strict mode, retrying]`);
            messages.push({
              role: 'user',
              content: `[Grounding Error: Missing @grounding[файл: path] marker. Try again with proper grounding marker before each tool call.]`,
            });
            continue;
          }

          if (!quiet) renderer?.writeDim(`  [grounding: missing marker, reminder ${consecutiveMissingGrounding}/${maxMissing}]`);
          messages.push({
            role: 'user',
            content: `[Reminder: Include @grounding[файл: path] marker before each <tool_call> to prevent path hallucinations.]`,
          });
          continue;
        } else {
          consecutiveMissingGrounding = 0;

          // Проверка соответствия пути в маркере и в аргументах tool_call
          for (let i = 0; i < pathCalls.length && i < groundPaths.length; i++) {
            const callPath = String(pathCalls[i].parsed.arguments.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
            const groundPath = groundPaths[i].replace(/\\/g, '/').replace(/^\.\//, '');
            if (callPath && groundPath && !callPath.endsWith(groundPath) && !groundPath.endsWith(callPath)) {
              if (!quiet) renderer?.writeWarning(`  [grounding: path mismatch — marker says "${groundPath}", tool says "${callPath}"]`);
              messages.push({
                role: 'user',
                content: `[Warning: Grounding marker path "${groundPath}" doesn't match tool call path "${callPath}". Fix the marker to match the actual path.]`,
              });
              break;
            }
          }
        }
      }
    }

    // ─── Enforce: лимиты на запись файлов ────────────────
    // Отслеживание повторных чтений одного файла для консолидации
    let lastReadFile: { path: string; offset: number; limit: number; content: string; toolId: string } | null = null;

    // Блокировка прямых write_file когда есть план с 3+ шагами — force subagent
    const planSteps = showPlan();
    const hasMultiStepPlan = planEnforcement && !planSteps.startsWith('No active plan') && (planSteps.match(/\n/g) || []).length >= 3;
    if (hasMultiStepPlan) {
      const directWrites = validCalls.filter(c => c.parsed.name === 'write_file' || c.parsed.name === 'edit_file');
      const hasSubagent = validCalls.some(c => c.parsed.name === 'subagent');
      const hasBash = validCalls.some(c => c.parsed.name === 'bash');
      if (directWrites.length > 0 && !hasSubagent) {
        // Block direct writes — model must use subagent
        for (const wc of directWrites) {
          const idx = validCalls.indexOf(wc);
          if (idx !== -1) validCalls.splice(idx, 1);
          const blockId = generateToolCallId();
          messages.push({
            role: 'tool',
            content: `BLOCKED: Multi-step plan active. Use subagent for each step. Example: subagent({task:"Create file X", existingFiles:"Y.ts"}). After subagent completes, mark step done: plan({action:"done", step:N})`,
            tool_call_id: blockId,
          });
        }
        if (!quiet) {
          renderer?.writeWarning(`  [blocked ${directWrites.length} direct writes — use subagent for multi-step plans]`);
        }
      }
      // Allow bash for verification (tsc --noEmit, npm run build) — don't block these
    }

    // ESCALATION: block write_file when creating N+ files without subagent (no plan case)
    if (directWriteStreakMax < Infinity && !hasMultiStepPlan) {
      const hasWrite = validCalls.some(c => c.parsed.name === 'write_file');
      const hasSubagentNow = validCalls.some(c => c.parsed.name === 'subagent');
      if (hasSubagentNow) {
        directWriteStreak = 0;
      } else if (hasWrite) {
        const writeCount = validCalls.filter(c => c.parsed.name === 'write_file').length;
        directWriteStreak += writeCount;
        if (directWriteStreak >= directWriteStreakMax) {
          const directWrites = validCalls.filter(c => c.parsed.name === 'write_file');
          for (const wc of directWrites) {
            const idx = validCalls.indexOf(wc);
            if (idx !== -1) validCalls.splice(idx, 1);
          }
          if (directWrites.length > 0) {
            const blockId = generateToolCallId();
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
      }
    }

    // Блокировка нескольких записей файлов за один ответ — максимум одна
    const writeCalls = validCalls.filter(c => c.parsed.name === 'write_file' || c.parsed.name === 'edit_file');
    if (writeCalls.length > 1) {
      // Keep only the first write call, block the rest
      const blocked = writeCalls.slice(1);
      validCalls.splice(validCalls.indexOf(blocked[0]), blocked.length);
      for (const bc of blocked) {
        const blockId = generateToolCallId();
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
      const toolId = generateToolCallId();

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
          // Авто-пометка следующего pending шага как in_progress
          const nextPending = getNextPendingStep();
          if (nextPending) {
            updatePlanStep(nextPending.id, 'in_progress');
          }

          // Phase 2.3: Авто-подстановка полного пути в задачу subagent
          let finalTask = task;
          if (nextPending) {
            const expectedDir = extractDirFromStepTitle(nextPending.title);
            if (expectedDir && !task.includes(expectedDir + '/')) {
              finalTask = `${task} (directory: ${expectedDir}/)`;
              logInfo('AGENT', `injected dir path into subagent task: "${expectedDir}"`);
            }
          }

          const autoContext = buildSubagentContext(process.cwd());
          logInfo('AGENT', `spawning subagent | task: "${finalTask.slice(0, 150)}"`);
          // Показываем спиннер на основном рендерере пока субагент работает
          if (!quiet) {
            const taskPreview = finalTask.length > 60 ? finalTask.slice(0, 57) + '...' : finalTask;
            renderer?.writeSpinner(` [subagent] ${taskPreview}`);
          }
          const subRenderer = new SubagentRenderer();
          try {
            const childResult = await runIsolatedLoop(
              provider, registry, finalTask, autoContext, process.cwd(), quiet, subRenderer, toolExecutor,
              modeConfig.subagentMode,
              llmCfg.toolModel,
            );
            toolOutput = childResult.summary;
            logInfo('AGENT', `subagent returned | files: ${childResult.createdFiles.length} | turns: ${childResult.turns} | errors: ${childResult.errors.length}`);
            if (childResult.createdFiles.length > 0) {
              for (const f of childResult.createdFiles) {
                if (!createdFiles.includes(f)) createdFiles.push(f);
              }
            }

            // Phase 2.1: Валидация путей созданных файлов
            if (nextPending && childResult.createdFiles.length > 0) {
              const expectedDir = extractDirFromStepTitle(nextPending.title);
              if (expectedDir) {
                const wrongDirFiles = childResult.createdFiles.filter(f =>
                  !f.startsWith(expectedDir + '/') && !f.startsWith(expectedDir + '\\')
                );
                if (wrongDirFiles.length > 0) {
                  const correction = `⚠ Files created in wrong directory: ${wrongDirFiles.join(', ')}. ` +
                    `They should be in ${expectedDir}/. Use write_file with full path: ${expectedDir}/${wrongDirFiles[0]}`;
                  toolOutput += '\n\n' + correction;
                  if (!quiet) {
                    renderer?.writeWarning(`  [subagent created files in wrong directory: ${wrongDirFiles.join(', ')}]`);
                  }
                }
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
          renderer?.clearSpinner();
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
      if (readConsolidation && !isBash && parsed.name === 'read_file' && toolExitCode === 0) {
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

      messages.push({
        role: 'tool',
        content: truncateToolOutput(parsed.name, toolOutput, toolExitCode),
        tool_call_id: toolId,
      });

      // ─── Error escalation + specialist auto-delegation ──────────
      if (toolExitCode !== 0 && toolOutput) {
        totalToolErrors++;
        const errKey = `${parsed.name}::${toolOutput.slice(0, 100).replace(/[A-Z]:\\[^\s"']+/gi, '<PATH>').replace(/\/[^\s"']+/g, '<PATH>')}`;
        const prevCount = consecutiveToolErrors.get(errKey) ?? 0;
        consecutiveToolErrors.set(errKey, prevCount + 1);
        const errorCount = prevCount + 1;

        // ── Specialist: авто-делегация при повторяющихся ошибках ──
        const specialistCfg = getSpecialistConfig(config);
        if (
          specialistCfg.enabled &&
          errorCount === specialistCfg.triggerThreshold &&
          specialistSpawnedFor !== errKey &&
          !isTrivialError(parsed.name, toolOutput) &&
          toolOutput.length >= specialistCfg.minErrorLength
        ) {
          specialistSpawnedFor = errKey;
          const spawned = await spawnSpecialist({
            provider, registry, toolExecutor, modeConfig, llmCfg, specialistCfg,
            quiet, renderer, messages, toolId, createdFiles,
            toolName: parsed.name, toolArgs: parsed.arguments,
            errorOutput: toolOutput, errorCount, enrichedPrompt,
          });
          if (spawned) continue;
        }

        // ── Escalation: hint / strategy switch / block ──
        if (errorCount > specialistCfg.triggerThreshold) {
          // Веб-специфичные подсказки
          let webHint = '';
          if (parsed.name === 'web_browse' && String(parsed.arguments?.action) === 'evaluate') {
            webHint = ' For web scraping: use web_browse(action:"discover") to find real CSS selectors, or web_browse(action:"get_links") to see all links, or web_browse(action:"extract", format:"html") to inspect the page structure.';
          } else if (parsed.name === 'web_browse' && String(parsed.arguments?.action) === 'navigate' && toolOutput.includes('Status: 40')) {
            webHint = ' Page returned HTTP error. Try navigating to the site homepage first, then use web_browse(action:"get_links") or web_browse(action:"discover") to explore available categories and sections instead of guessing URLs.';
          }

          const msg = errorCount === specialistCfg.triggerThreshold + 1
            ? `[System: Tool "${parsed.name}" failed with the SAME error ${errorCount} times. Read the error message carefully. The input is likely wrong — try a completely different approach, or use subagent for a fresh context.]${webHint}`
            : `[System: Tool "${parsed.name}" failed ${errorCount} times with the same error. STOP. Do NOT retry the same call. Use subagent(task="...") for a fresh context, or tell the user you're stuck.]${webHint}`;
          messages.push({ role: 'user', content: msg });
          if (!quiet) renderer?.writeWarning(`  [error escalation: ${parsed.name} failed ${errorCount} times]`);
        }

        if (totalToolErrors >= 5 && errorStrategy === 'normal') {
          errorStrategy = 'subagent-hint';
          messages.push({ role: 'user', content: `[System: ${totalToolErrors} tool errors. Use subagent(task="...") for a fresh context.]` });
          if (!quiet) renderer?.writeWarning(`  [strategy: subagent-hint after ${totalToolErrors} errors]`);
        }

        if (errorCount >= 4) {
          const blockId = generateToolCallId();
          messages.push({ role: 'tool', content: `BLOCKED: Tool "${parsed.name}" failed ${errorCount} times. Temporarily blocked.`, tool_call_id: blockId });
          const idx = validCalls.indexOf(call);
          if (idx !== -1) validCalls.splice(idx, 1);
          if (!quiet) renderer?.writeWarning(`  [blocked ${parsed.name}: too many repeated errors]`);
        }
      } else {
        for (const [key] of consecutiveToolErrors) {
          if (key.startsWith(parsed.name + '::')) consecutiveToolErrors.delete(key);
        }
        specialistSpawnedFor = null;
      }

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

  // Agent:done event for notify plugin
  if (pluginManager.isActive('notify')) {
    pluginManager.emit('agent:done').catch(() => {});
  }

  return { messages };
}
