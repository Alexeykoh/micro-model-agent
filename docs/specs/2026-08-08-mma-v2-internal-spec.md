# MMA v2 — Internal Architecture Specification

> Дата: 2026-08-08 | Версия: v0.28.0 | Статус: анализ + исправления (3 волны) | Всего исправлено: 23 бага

---

## Bug Fixes Applied (2026-08-08)

### Wave 1 (исходный баг «привет → React»)
| # | Bug | Файл | Фикс |
|---|-----|------|------|
| F1 | restorePlan() на свежих сессиях | `bootstrap.ts:327` | Только при `messageCount > 0` |
| F2 | plan update без step | `module.ts:190` | Поддержка `title`+`steps` (пересоздание) |
| F3 | i18n ключ plan.updated | `en.json`, `ru.json` | Добавлен |

### Wave 2 (надёжность агента)
| # | Bug | Файл | Фикс |
|---|-----|------|------|
| F4 | compact() не сбрасывал iterationsSinceCompaction (H13) | `context/manager.ts:280` | Сброс ПЕРЕД проверкой |
| F5 | extractTriedAndFailed на свежих сообщениях (H12) | `context/manager.ts:303` | `oldTurns` вместо `this.messages` |
| F6 | reconfigure() не обновлял toolCtx.llmProvider (H4) | `agent.ts:808` | `(executor as any).ctx.llmProvider = newProvider` |
| F7 | Проектные плагины из неверной директории (H3) | `bootstrap.ts:404` | `join(baseDir, ...)` |
| F8 | todo done — no-op (M1) | `module.ts:262` | updateStepStatus + syncCurrentStep + persister.save |
| F9 | move-file без safeResolvePath (H10) | `move-file.ts:23` | `safeResolvePath()` |
| F10 | grep-tool shell injection (M8) | `grep-tool.ts:52` | `execFileSync` с массивом вместо shell-строки |
| F11 | Math.max(...[]) → -Infinity + dead code (C5) | `diff.ts:172` | Guard + удаление unreachable кода |
| F12 | Пустые i18n-строки возвращали ключ (M21) | `i18n/index.ts:41` | `??` вместо `\|\|` |

### Wave 3 (текущая)
| # | Bug | Файл | Фикс |
|---|-----|------|------|
| F13 | parseInt без NaN (H14) | `config.ts:110` | `isNaN` guard |
| F14 | AbortSignal.any() не в Bun (H6) | `openai-compat.ts:121` | try/catch + manual fallback |
| F15 | Битый JSON → потеря истории (H7) | `store.ts:142` | Per-line resilient parsing |
| F16 | То же для session.jsonl | `store.ts:201` | Per-line resilient parsing |
| F17 | O(N²) meta-чтений (M17) | `store.ts:49,121,104,259` | In-memory cache `_metaCache` |
| F18 | Хардкод «ст.» (M2) | `planner.ts:60` | `[${stepCount}]` без суффикса |
| F19 | Дубликат «jsx» (M4) | `plan-coverage.ts:22` | Удалён дубликат |
| F20 | Force-exit таймер не сбрасывался (M5) | `repl.ts:293` | Переменная `forceExitTimer` |
| F21 | lint-on-write module-level state (H9) | `lint-on-write.ts:7` | `this._checkPromise` / `this._checkTimestamp` |
| F22 | search-history всегда success:true (M9) | `search-history.ts:62` | `success: false` |
| F23 | verifyAndMerge без try/catch (H5) | `agent-moe.ts:122` | try/catch с fallback-результатом |

---

## Содержание

1. [Точки входа](#1-точки-входа)
2. [Bootstrap — инициализация агента](#2-bootstrap--инициализация-агента)
3. [Agent Loop — основной цикл](#3-agent-loop--основной-цикл)
4. [System Prompt — сборка контекста](#4-system-prompt--сборка-контекста)
5. [LLM-слой — общение с моделью](#5-llm-слой--общение-с-моделью)
6. [Tools — инструменты агента](#6-tools--инструменты-агента)
7. [Execution — планирование и контроль](#7-execution--планирование-и-контроль)
8. [Context — управление контекстом](#8-context--управление-контекстом)
9. [Hallucination — проверка ответов](#9-hallucination--проверка-ответов)
10. [Session — сессии и история](#10-session--сессии-и-история)
11. [Memory — долгосрочная память](#11-memory--долгосрочная-память)
12. [Indexer — карта проекта](#12-indexer--карта-проекта)
13. [Skills — навыки](#13-skills--навыки)
14. [Plugins — плагины](#14-plugins--плагины)
15. [Browser — браузер](#15-browser--браузер)
16. [MCP — внешние сервера](#16-mcp--внешние-сервера)
17. [LSP — языковые сервера](#17-lsp--языковые-сервера)
18. [Security — безопасность](#18-security--безопасность)
19. [Processes — управление процессами](#19-processes--управление-процессами)
20. [UI — рендеринг](#20-ui--рендеринг)
21. [Config — конфигурация](#21-config--конфигурация)
22. [I18n — интернационализация](#22-i18n--интернационализация)
23. [Сводная таблица багов](#23-сводная-таблица-багов)

---

## 1. Точки входа

### 1.1 CLI (`bun run mma`)

Файл: `src/cli/main.ts:14` — `main()`

Три режима запуска:

| Режим | Команда | Логика |
|-------|---------|--------|
| Subcommand | `mma init`, `mma session list`, ... | Команда выполняется внутри Commander, `main.ts` сразу возвращает |
| Single-run | `mma "prompt"` | `bootstrap()` → `agent.run(prompt, ...)` → вывод результата → `agent.shutdown()` |
| JSON mode | `mma "prompt" --json` | То же, но результат пишется в stdout как JSON, exit code 0/1 |
| REPL | `mma` (без аргументов) | Проверка first-run → setup wizard → `bootstrap()` → `new Repl(...)` → `repl.start()` |

**⚠️ Слабые места:**
- **`main.ts:105`**: При first-run `bootstrap()` вызывается **дважды** — первый агент создаётся и отбрасывается без `shutdown()`. Утечка процессов/вотчеров.
- **`main.ts:61`**: В JSON-режиме `process.exit()` вызывается до `agent.shutdown()`. Фоновые процессы не убиваются (хоть процесс и умирает сам).
- **`main.ts:68-86` и `repl.ts:338-356`**: Колбэки Renderer-а (4 штуки) дублируются в двух местах.

### 1.2 REPL

Файл: `src/cli/repl.ts:66` — класс `Repl`

**Жизненный цикл:**
```
start()
  → показ info-бокса (модель, провайдер, контекст, сессия, ...)
  → rl.prompt()
  → ожидание ввода

line handler (на каждый Enter):
  → если agentRunning || inputLocked → записать в историю, пропустить
  → если многострочный ввод → накопить в буфер, при завершении — dispatch
  → если начинается с "/" → executeCommand()
  → иначе → runAgent()
```

**Клавиши:**
- `Esc Esc` (double): `agent.shutdown()` с обнаружением по счётчику ESC-байтов + временному окну 500мс
- `Ctrl+C`: `agent.shutdown()` + отложенный `process.exit(1)` через 2с
- `Ctrl+V`: вставка изображения из буфера обмена

**⚠️ Слабые места:**
- **`repl.ts:300`**: Таймер force-exit 2с **не очищается** при успешном shutdown. Процесс упадёт через 2с после любого Ctrl+C.
- **`repl.ts:286-288`**: Ошибки чтения буфера обмена глотаются пустым `catch`. Bun API changes, OOM, permissions — всё невидимо.
- **`repl.ts:415`**: `require("./repl-commands")` в ES-модуле — работает под Bun, но нестандартно.

### 1.3 Флаги

| Флаг | Действие |
|------|----------|
| `--no-agents-md` | Пропустить загрузку AGENTS.md файлов |
| `-d <dir>` | Рабочая директория (projectDir) |
| `-e, --exit-on-complete` | Выход после первого финального ответа |
| `-j, --json` | Машиночитаемый JSON-вывод |

---

## 2. Bootstrap — инициализация агента

Файл: `src/core/bootstrap.ts:141` — `bootstrap()`

**Полная последовательность (36 шагов):**

| # | Что происходит | Строки |
|---|---------------|--------|
| 1 | Резолв директорий: `~/.mma/`, `<project>/.mmrc` | 147-151 |
| 2 | `loadConfig()` — трёхслойный мёрж: defaults → `~/.mma/config.json` → `.mmrc` | 152 |
| 3 | `setLocale(config.locale)` | 153 |
| 4 | Динамический импорт `globalAuditNotifier` (с try/catch) | 156-168 |
| 5 | Создание Logger, `setLogDir()` | 170-175 |
| 6 | Model auto-load (если `modelLoad.autoLoad`) | 177-196 |
| 7 | User Profile: `load()` или `collect()` + `save()` | 198-200 |
| 8 | `new OpenAICompatProvider(...)` | 202-209 |
| 9 | `baseDir = resolve(projectDir) \|\| process.cwd()` | 211 |
| 10 | `IndexerModule + buildIndex()` (с try/catch) | 213-222 |
| 11 | Skills: `SkillsLoader.loadFromAllSources()` → `SkillsModule` | 224-240 |
| 12 | `new ToolRegistry()` + `registerAllTools()` (~25 тулов) | 242-243 |
| 13 | `new PluginManager()` | 245 |
| 14 | `buildSystemInfo()` → PromptBlock (critical, essential) | 247-252 |
| 15 | Создание `~/.mma/AGENTS.md` если нет | 254-257 |
| 16 | `SessionStore` + `SessionManager` + автосоздание сессии | 259-272 |
| 17 | `TokenCounter + ContextManager` | 274-280 |
| 18 | Сборка ToolContext (вручную, 10 полей) | 282-316 |
| 19 | `new ToolExecutor()` + backfill `toolCtx.llmProvider/toolExecutor` | 318-320 |
| 20 | `new HallucinationDetector()` | 322 |
| 21 | `new ModuleRegistry()` | 324 |
| 22 | `new ExecutionModule()` + **restorePlan()** (только при messageCount > 0) | 326-331 |
| 23 | `new SessionModule()` | 333-334 |
| 24 | Регистрация Skills + Indexer | 336-337 |
| 25 | `new MCPModule()` + `await initialize()` | 339-341 |
| 26 | `new MemoryModule()` | 343-344 |
| 27 | `new BrowserModule()` (если `browser.enabled`) | 346-354 |
| 28 | `new LspModule()` | 356-362 |
| 29 | Сбор тулов из всех модулей → регистрация в ToolRegistry | 364-367 |
| 30 | Регистрация плагинов из модулей (execution, session, skills, indexer, MCP) | 369-397 |
| 31 | Регистрация встроенных плагинов (lint-on-write, notify) | 399-400 |
| 32 | Загрузка внешних плагинов из `~/.mma/plugins/` | 402-406 |
| 33 | `contextManager.onCompact` — колбэк сохранения в сессию | 408-417 |
| 34 | Загрузка AgentsMd файлов (project, project/.mma, global) | 419-440 |
| 35 | Сборка AgentDeps + `getDynamicPromptBlocks` + `finalAudit` | 442-465 |
| 36 | `new Agent(agentDeps)` → return | 467-478 |

**⚠️ Слабые места:**
- **`bootstrap.ts:156-168`**: Ошибка audit-notifier глотается пустым `catch {}` — нулевая видимость.
- **`bootstrap.ts:271`**: `sessionManager.create()` без try/catch — диск переполнен = краш bootstrap-а.
- **`bootstrap.ts:251`**: `estimatedTokens: 250` для systemInfo (реально ~1100 токенов) — оценка занижена в 4x.
- **`bootstrap.ts:404`**: `join(dir, ".mma", "plugins")` — **баг**: вместо `<project>/.mma/plugins` грузит `~/.mma/.mma/plugins`. Проектные плагины не грузятся.
- **`bootstrap.ts:110-114`**: `parseInt(env.MMA_*)` без `isNaN` проверки — NaN при нечисловых значениях.
- **`bootstrap.ts:319-320`**: `toolCtx` мутируется ПОСЛЕ создания ToolExecutor — циклическая зависимость через backfill.

---

## 3. Agent Loop — основной цикл

Файл: `src/core/agent.ts:71` — класс `Agent`

### 3.1 `Agent.run(input, callbacks)`

```
run() → setScope() → создать SessionLogger
  → авто-сессия если нет активной
  → buildSystemPrompt() → добавить system сообщение В ПЕРВЫЙ РАЗ
  → плагин onSessionStart
  → baseline typecheck (fire-and-forget)
  → contextManager.addMessage({role:"user", content:input})
  → если moe.enabled → runWithMoE() с fallback на single-agent
  → иначе → executeSingleAgentLoop()
```

### 3.2 `executeSingleAgentLoop()` — главный while

**Условие:** `iteration < maxToolIterations && !shutdownRequested`

**На каждой итерации:**

```
1. iteration++, noteIteration()
2. runOnBeforeThink() plugin hook
3. Проверка компакшена (regular / quality < 40 / overflow)
4. refreshSystemPrompt() — обновляет динамические блоки (план)
5. toolExecutor.getToolDefinitions(filterByTags)
6. llmProvider.chat(history, tools, abortSignal) — СТРИМИНГ
   ├─ doStream() → если нет ни текста ни tool call → doNonStreaming()
   └─ сбор textContent, reasoningContent, toolCalls[]
7. Показ текста модели (с учётом toolComments и isToolCallJson)
8. runOnAfterThink()
9. Если есть tool calls:
   ├─ ПОСЛЕДОВАТЕЛЬНЫЙ for...of по tool calls
   │  ├─ setScope(), runOnToolCall(), runOnToolStart()
   │  ├─ toolExecutor.execute(call, signal)
   │  ├─ runOnToolEnd(), runOnAfterTool()
   │  ├─ trackCreatedFile / trackDeletedFile
   │  ├─ contextManager.addMessage({role:"tool", ...})
   │  └─ sessionLog.logToolResult()
   ├─ Добавление system-summary со сводкой всех tool results
   ├─ Показ context bar
   └─ continue
10. Если нет tool calls:
   ├─ hallucinationDetector.validate(textContent)
   │  ├─ block → return error
   │  ├─ warn → prefix + continue
   │  ├─ retry → контекст + continue (max 3 попытки)
   │  └─ pass → continue
   ├─ contextManager.addMessage({role:"assistant", content})
   ├─ finalAudit() — ЕСЛИ ЕСТЬ АКТИВНЫЙ ПЛАН
   │  ├─ если !passed → <system-summary> warning + continue (max 3 retries)
   │  └─ если passed → break
   └─ break (если нет плана)
```

**⚠️ Слабые места:**
- **`agent.ts:280`**: `hallucinationRetries` никогда не сбрасывается за весь ран. После 3 ретраев — всё.
- **`agent.ts:727-754`**: **Final Audit gate** — если восстановлен старый план, на любой текстовый ответ (включая "привет") срабатывает `finalAudit()` и принуждает продолжить. **Это причина бага "привет → создание React-приложения"**.
- **`agent.ts:510`**: tool calls выполняются **последовательно** (не параллельно). Три вызова = три await.
- **`agent.ts:796-816`**: `reconfigure()` меняет `this.deps.llmProvider`, но **не обновляет** `toolCtx.llmProvider`. Любой тул, читающий `ctx.llmProvider`, получает устаревший провайдер.
- **`agent.ts:520-527`**: `move_file` не отслеживается в hallucination file tracking.
- **`agent.ts:462-468`**: Exit-on-complete guard на повторяющиеся tool calls — может false-positive на легитимных одинаковых вызовах.

### 3.3 MoE (`agent-moe.ts`)

Если `config.moe.enabled`: Router → plan → validate → execute (parallel waves) → verify/merge. При любой ошибке — fallback на single-agent.

**⚠️ Слабые места:**
- `agent-moe.ts:56-64`: `onPhase("done")` не вызывается на пути ошибки планирования — спиннер крутится вечно.
- `agent-moe.ts:121-133`: `orchestrator.verifyAndMerge()` без try/catch — исключение крашит MoE.
- `agent-moe.ts:106-114`: `knownTags` хардкожены — не синхронизируются с новыми тегами тулов.

---

## 4. System Prompt — сборка контекста

Файл: `src/core/prompt-builder.ts` — класс `PromptBuilder`

### 4.1 Бюджет

```typescript
systemBudget = contextWindow * contextBudget.systemPrompt
// Default: 32768 * 0.10 = 3276 токенов
```

### 4.2 Порядок блоков

1. **Essential-блоки** (всегда включаются, независимо от бюджета)
2. **Non-essential блоки** — жадный алгоритм по приоритету: `critical` → `high` → `normal` → `low`. Блок, превышающий доступный бюджет, исключается.

Несколько блоков одного приоритета сортируются через `Array.sort()` — сортировка **не гарантированно стабильна**.

### 4.3 Источники блоков

| Источник | Блоки | Приоритет |
|----------|-------|-----------|
| `buildSystemInfo()` | System info (OS, shell, workspace, design rules, Windows hints, bash rules, development rules, plan quality rules, autoPlan directive) | critical, essential |
| `moduleRegistry.collectPromptBlocks()` | От всех модулей (execution, session, skills, indexer, MCP, memory, browser, LSP) | зависит от модуля |
| AgentsMd files | До 3-х файлов: project/AGENTS.md + project/.mma/AGENTS.md + ~/.mma/AGENTS.md | high |
| `getDynamicPromptBlocks()` | **План** (execution module) — обновляется КАЖДУЮ итерацию | critical, essential |
| Plugin `onBuildPrompt` | Строки от плагинов | low |

**⚠️ Слабые места:**
- **`prompt-builder.ts:45-47`**: Нестабильная сортировка — блоки одного приоритета могут менять порядок между пересборками.
- **`prompt-builder.ts:64`**: Исключённые блоки сохраняются в памяти ПОЛНОСТЬЮ (для подсчёта количества). Можно хранить только идентификаторы.
- Нет минимальной гарантии бюджета — если essential-блоки превышают бюджет, они всё равно включаются.
- `buildSystemInfo()` содержит хардкоженную строку `[${stepCount} ст.]` (русская аббревиатура) без i18n.

### 4.4 Development Rules (входят в system info)

9 жёстких правил в системном промпте, включая:
- "Plan rule (MANDATORY): For ANY task ... you MUST create a plan" (если `autoPlan: true`)
- "Follow the plan sequentially. Complete step N before starting step N+1."
- "When a step is done: verify the deliverables exist ... then call plan update step=N status=done"

Эти правила + восстановленный план = модель ПРИНУЖДЕНА следовать плану.

---

## 5. LLM-слой — общение с моделью

Файлы: `src/llm/provider.ts`, `openai-compat.ts`, `token-counter.ts`

### 5.1 OpenAICompatProvider.chat()

```
chat(messages, tools, signal)
  → rateLimiter.check → да/нет
  → doStream(messages, tools, signal)  // stream: true
     → fetchWithRetry(body)  // до 4 попыток (3 retries)
     → парсинг SSE чанков
     → если нет ни текста ни tool_call → fallback
  → doNonStreaming(messages, tools, signal)  // stream: false — Jinja fix
     → fetchWithRetry(body)
     → парсинг JSON response
```

### 5.2 Retry logic

- 3 ретрая (всего до 4 попыток) с экспоненциальной задержкой (1s → 2s → 4s)
- Джиттер: `Math.random() * baseDelay * 0.1` — не зависит от величины задержки (на 3-й попытке джиттер всё ещё 0-100мс)
- Повторяются только 429 и 5xx. 400, 401 — сразу ошибка.

### 5.3 Jinja-совместимость

- System сообщение всегда ПЕРВОЕ (добавляется в `agent.ts:208` один раз)
- Все последующие системные сообщения идут как `role: "user"` в `<system-summary>`
- Non-streaming режим явно шлёт `stream: false` в body

### 5.4 Token Counter

- Всегда использует кодировку `gpt-4o` (cl100k_base), независимо от модели
- Для Qwen 3.5 подсчёт токенов неточен
- Фолбэк: `content.length / 2` (грубая эвристика)

**⚠️ Слабые места:**
- **`openai-compat.ts:121-123`**: `AbortSignal.any()` может отсутствовать в некоторых версиях Bun — runtime exception.
- **`openai-compat.ts:180-186`**: Usage чанк ловится только при отсутствии `choices[0]` — некоторые провайдеры шлют usage вместе с контентом, теряется.
- **`openai-compat.ts:216-230`**: Tool calls выдаются только при `finish_reason === "tool_calls"`. Если стрим прерван — partial tool calls теряются.
- **`token-counter.ts:9,41`**: Всегда gpt-4o encoding. Qwen считает токены иначе.
- **`openai-compat.ts:69`**: `reasoningAcc` накапливается но **никогда не используется** — мёртвая переменная.
- **`response.ts`**: Весь файл — неиспользуемый код. `parseChunks()` не вызывается из agent loop. Агент делает свой парсинг.

---

## 6. Tools — инструменты агента

Файлы: `src/tools/`

### 6.1 ToolExecutor (`executor.ts`)

Pipeline: `lookup → onBeforeTool (плагины, может заблокировать) → handler (с таймаутом 60s) → onAfterTool → логгирование`

**Интерактивные тулы** (question/approve — disabled) пропускают таймаут.

**⚠️ Слабые места:**
- `executor.ts:74-76`: `interactive: true` проверка — но question/approve отключены, единственный интерактивный тул не используется.
- `executor.ts:53`: `plugin.constructor?.name` — для plain-объектов вернёт `"Object"`, не `"unknown"`.
- `executor.ts:103-104`: abort listener: если `killByCallId` бросает исключение (процесс уже удалён), оно ловится как «timeout», а не «abort».

### 6.2 Инвентарь тулов

**Зарегистрированы в `registerAllTools()` (22 тула):**
`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `list_dir`, `create_dir`, `delete_file`, `move_file`, `file_info`, `bash`, `subagent`, `process_list`, `process_log`, `process_kill`, `web_search`, `web_fetch`, `web_browse`, `pipeline_run`, `mcp_call`, `search_history`, `attach_image`

**Зарегистрированы модулями:**
`plan`, `todo`, `verify` (execution), `browser` (browser), `project_map` (indexer), `load_skill` (skills)

**Dead code (никогда не регистрируются):**
`remember`, `recall` — импортированы из `index.ts` но не в массиве `registerAllTools()`

### 6.3 Безопасность тулов

**Path safety:**
- `safeResolvePath()` — фиксит ошибки моделей в путях (ведущий `/`, пропущенный разделитель)
- `isPathInScope()` / `isPathWritable()` — проверка scope под-агентов + глобальные denied-паттерны
- **`move_file.ts:23-27`**: НЕ использует `safeResolvePath()` — использует `resolve(normalize())`. Несовместимость с остальными тулами.

**Bash security:**
- Blacklist опасных команд (`rm`, `dd`, `chmod`, `...`)
- Blocking опасных флагов (`--force`, `-rf`, `...`)
- Windows: авто-перевод Unix-команд (`ls` → `dir`, etc.)
- Авто-промоушен в фон через 5s
- Декодирование CP866 на Windows (хардкожено — не работает для не-кириллических локалей)

**Content scanning:**
- `write_file`, `edit_file`: проверка на `eval(`, `child_process.exec(`, `rm -rf`, ...
- `web_fetch`, `web_search`: проверка URL через `isUrlAllowed()`

**⚠️ Слабые места:**
- **`grep-tool.ts:53`**: Shell injection в fallback-режиме — `execSync` с пользовательским pattern, только quote-escape.
- **`move-file.ts:51,68`**: `isPathWritable` вызывается с RAW путём, а файловая операция — с resolved (разные алгоритмы резолва).
- **`search-history.ts:63`**: Всегда возвращает `success: true` даже при ошибке.
- **`read-file.ts:63`**: CRLF не обрабатывается — `\r` остаётся в строках.
- **`write-file.ts:107`**: `(ctx as any).fileOperationsCount` — обход типов TypeScript.
- **`subagent.ts:139`**: **Шаринг executor-а** с родителем — sub-agent вызывает `setScope()` и мутирует общий скоуп.
- **`move-file.ts`**: Не хватает `safeResolvePath()` — самый опасный filesystem тул без защиты от model path mistakes.
- **`processes/registry.ts:102-103`**: CP866 хардкожен — garbled output на не-русской Windows.

### 6.4 Интерактивные тулы (disabled)

`question.ts`, `approve.ts` — отключены (слишком деструктивны для малых моделей). Исходники есть, импорты закомментированы в `index.ts:29-32`.

---

## 7. Execution — планирование и контроль

Файлы: `src/modules/execution/`

### 7.1 Plan lifecycle

```
Создание: model → plan {action:"create", title, steps[...]}
  → PlanCreator.createPlan()  [planner.ts:52]
  → ExecutionModule.setPlan() [module.ts:43]
  → persister.save()          [plan-persister.ts:25]
  → .mma/plan.json

Восстановление: bootstrap → ExecutionModule.restorePlan()  [module.ts:48]
  ТОЛЬКО при messageCount > 0 (фикс 2026-08-08)
  → persister.load()          [plan-persister.ts:37]
  → new PlanTracker(plan)
  → tracker.syncCurrentStep()

Пошаговое обновление: model → plan {action:"update", step:N, status:"done"}
  → tracker.updateStepStatus()
  → tracker.syncCurrentStep()
  → persister.save()

Полное пересоздание: model → plan {action:"update", title, steps[...]}
  → PlanCreator.createPlan()
  → setPlan()

Отмена: model → plan {action:"abort"}
  → tracker = null
  → persister.clear()
```

### 7.2 Plan Tracker (`tracker.ts`)

- `currentStepIndex` — указатель на текущий шаг
- `syncCurrentStep()` — проматывает указатель через done/skipped шаги (без мутации статуса)
- `advance()` — инкремент + mark in_progress
- `getProgressString()` — прогресс-бар `████░░░░ NN%`

### 7.3 Plan Alignment (`module.ts:501-541`)

При каждом tool call проверяется: соответствует ли файл из аргументов тула текущему шагу плана? Always-allowed: `plan, todo, verify, list_dir, read_file, glob, grep, file_info, load_skill`. После 3-х предупреждений подряд — блокировка тула.

### 7.4 Step Auto-Advance (`module.ts:543-641`)

После успешного `write_file`/`edit_file`:
1. Deps gate: если шаг про установку зависимостей — проверить lock-файлы
2. Empty file gate: файлы должны быть не пустыми (≥10 символов)
3. All files exist gate: все файлы из описания шага существуют

При прохождении — авто-переход на следующий шаг.

### 7.5 Stuck Detector (`stuck-detector.ts`)

- Порог застревания: 8 итераций на одном шаге
- Порог повторяющихся tool calls: 3 одинаковых
- Механика восстановления: hints, skill suggestions, альтернативные тулы, escalation, force-skip (>15 итераций)
- `checkOffTrack()` (строки 341-370) — **dead code**, нигде не вызывается

### 7.6 Final Audit (`auditor.ts` + `module.ts:69-93`)

Извлекает все расширения файлов из описаний шагов плана (`\b[\w./-]+\.[a-z]+`), проверяет существование. Если есть missingFiles → `passed: false`. В `runFinalAudit()` также проверяет `pendingSteps.length === 0`. Взаимодействие с `agent.ts:727-754`:

```
finalAudit() → !passed → inject system-summary → continue (max 3 retries)
```

**⚠️ Слабые места:**
- **`planner.ts:29-50`**: `isMultiStep()` — **dead code**, не вызывается нигде. Анти-паттерн keyword matching (правило AGENTS.md #10).
- **`planner.ts:60`**: `[${stepCount} ст.]` — хардкоженный русский текст без i18n.
- **`tracker.ts:37-44`**: `advance()` маркирует `in_progress`, даже если шаг уже `done` — перезапись статуса.
- **`tracker.ts:63-68`**: `isComplete()` не проверяет `currentStepIndex` — может быть true при несинхронизированном указателе.
- **`module.ts:262-267`**: `todo done` — **no-op**. Ничего не делает, просто возвращает success.
- **`plan-coverage.ts:22`**: `"jsx"` в `IGNORED_EXT` **дважды**.
- **`verifier.ts:55,59,69,74`**: Хардкоженные английские строки — мимо `t()`.
- **`stuck-detector.ts:341-370`**: `checkOffTrack()` — dead code.
- **`auditor.ts:28`**: Парсинг файлов из описаний через regex с удалением скобочных групп — не учитывает URL и другие не-файловые конструкции.

---

## 8. Context — управление контекстом

Файл: `src/modules/context/manager.ts:429` — ContextManager

### 8.1 Бюджет

```typescript
systemPrompt = contextWindow * 0.10   // default: 3276
responseReserve = contextWindow * 0.15 // default: 4915
history = contextWindow * 0.75         // default: 24577
```

### 8.2 Compaction

**Триггеры:** каждые 15 итераций ИЛИ при 75% заполнения history-бюджета.

**Механизм:**
1. Оставить последние 12 сообщений (KEEP_LAST_N * 2)
2. Извлечь факты из старых сообщений: файлы (последние 15), решения (последние 5), ошибки (последние 3)
3. Построить компактный summary блок
4. Вставить как `role: "user"` сообщение (Jinja-safe)
5. `[firstSystem, summary, ...recentTurns]`

**⚠️ Слабые места:**
- **`manager.ts:281`**: Если сообщений ≤ 12 — ранний возврат БЕЗ сброса `iterationsSinceCompaction`. После 15 итераций `needsCompaction()` будет вечно возвращать true, но `compact()` — no-op. **Баг бесконечных попыток компакшена.**
- **`manager.ts:303-305`**: `extractTriedAndFailed(this.messages)` — анализ на ПОЛНОМ массиве до компакшена, включая свежие сообщения. Неверно — свежие ошибки не должны помечаться как «уже пробовали».
- **`manager.ts:399-401`**: `getActiveHistory()` возвращает shallow copy — объекты Message не клонируются, мутация снаружи повредит внутреннее состояние.

### 8.3 Quality Formula

```
tokenLoad      = max(0, 1 - usedTokens / budget.history)           × 0.40
compactionLoss = max(0, 1 - compactionCount × 0.15)                × 0.25
errorDensity   = max(0, 1 - min(1, errorFacts / msgCount))         × 0.20
freshness      = max(0, 1 - iterationsSinceCompaction / 15)        × 0.15
quality = clamp(0, 100, score × 100)
```

Качество < 40% + compactionCount > 0 → принудительный компакшен.

### 8.4 Token Estimation

- С TokenCounter: точный подсчёт через js-tiktoken (но всегда gpt-4o encoding)
- Без: `content.length / 2`
- Изображения: `ceil(b64len / 512) * 130` токенов
- **Оценка токенов НЕ используется для обрезания контекста** — только для трекинга. LLM получает полный массив сообщений.

---

## 9. Hallucination — проверка ответов

Файлы: `src/modules/hallucination/`

### 9.1 Pipeline

```
ConfidenceCheck.validate(text)
  → retry/block → return immediately
  → warn/pass → continue
FactualCheck.validate(text)
  → warn → return immediately
  → pass → continue
LLMJudge.validate(text, consistency)
  → warn → collect
  → pass → continue
Aggregate: any warnings → {status:"warn"}, all pass → {status:"pass"}
```

### 9.2 ConfidenceCheck

- Пустой ответ → retry
- <5 слов без структуры → warn
- >50% пересечения слов с предыдущим ответом → retry
- <25% уникальных слов → warn

### 9.3 FactualCheck

Извлекает пути файлов из ответа, проверяет `existsSync()`. Файлы без расширения или с известными TLD (.com, .org) — игнорируются.

### 9.4 LLMJudge

LLM-as-judge для проверки противоречий в решениях. Fast path: если нет trackedDecisions → pass. Иначе: отправляет последние 6 решений модели, просит JSON-вердикт `{contradicts: true/false}`. Таймаут 15s. При ошибке — деградация в pass.

**⚠️ Слабые места:**
- **`confidence.ts:16`**: `MIN_CHARS = 1` — проверяет только пустую строку. 1 символ проходит.
- **`factual.ts:50`**: URL-пути с файловыми расширениями дают false-positive на несуществующие файлы.
- **`consistency.ts:15-21`**: `trackCreatedFile`/`trackDeletedFile` — dead code. Агент трекает только `trackDecision`.
- **`llm-judge.ts:88`**: Вызов LLM без AbortSignal — нельзя прервать при shutdown.
- **`llm-judge.ts:96-101`**: `Promise.race` между стримом и таймаутом — если стрим идёт дольше 15s, результат теряется.
- **`detector.ts:34-40`**: Short-circuit на confidence retry — factual check не выполняется. Повторяющийся ответ с несуществующими файлами не будет пойман.

---

## 10. Session — сессии и история

Файлы: `src/modules/session/`

### 10.1 Жизненный цикл

```
Создание: sessionManager.create(name?)
  → id = "ses_<timestamp36>_<random6>"
  → meta.json + директория

Запись: sessionManager.appendMessage(msg)
  → history.jsonl (JSONL, одна строка на сообщение)
  → meta.messageCount++
  → meta.updatedAt = now

Чтение: sessionStore.loadHistory(id)
  → readFileSync → split '\n' → JSON.parse каждой строки

Удаление: sessionManager.delete(id)
  → rmSync всей директории

Ротация: sessionStore.rotateOldSessions() — DEAD CODE, не вызывается
```

### 10.2 Шифрование

При `sessionEncryption.enabled`: каждая строка шифруется отдельно (AES-256-GCM). Каждая строка расшифровывается отдельно.

**⚠️ Слабые места:**
- **`store.ts:142-156`**: Одна битая JSON-строка → весь catch → return `[]`. **Вся история теряется из-за одной строки.**
- **`store.ts:134-139`**: `meta.messageCount` обновляется на КАЖДОМ `appendMessage` с полным циклом load/save meta.json. O(N²) для больших сессий.
- **`store.ts:217-236`**: `rotateOldSessions()` — dead code. Никакого авто-удаления старых сессий.
- **`session-isolation.ts:133-137`**: `cleanupSessionTempDir()` — no-op. Временные файлы копятся вечно.
- **`manager.ts:192-205`**: Security overrides только для 3 полей (maxFileOperations, maxRecursionDepth, rateLimits). Остальные security settings не переопределяются per-session.

---

## 11. Memory — долгосрочная память

Файлы: `src/modules/memory/`

Файлы в `~/.mma/memory/`: `conventions.md`, `decisions.md`, `errors.md`, `facts.md`, `preferences.json`

**⚠️ Слабые места:**
- **`memory/module.ts:20`**: Память `.md` файлов **никогда не попадает в системный промпт**. LLM видит только `preferences.json` как "User preferences". Доступ к `.md` через `recall` тул — но `recall` не зарегистрирован.
- **`tools/remember.ts`, `tools/recall.ts`**: Оба тула — **dead code**. Не в `registerAllTools()`.
- **`memory/store.ts:33-37`**: `append()` без дедупликации — идентичные записи копятся бесконечно. Нет лимита размера.
- **`memory/store.ts:57-61`**: `setPreference()` без атомарности — гонка при конкурентных вызовах.

---

## 12. Indexer — карта проекта

Файлы: `src/modules/indexer/`

- Рекурсивный обход файлов (кроме node_modules, .git, dist, build, .mma, coverage)
- Извлечение экспортов для TS/JS (другие языки — пустой массив)
- Кэш: `<project>/.mma/index-cache.json`
- Watcher: `fs.watch` с дебounce 2s
- Лимит: 1000 файлов (молча)

**⚠️ Слабые места:**
- **`walker.ts:42`**: `fs.watch` с `recursive:true` не поддерживается на Linux — только корень мониторится.
- **`walker.ts:43`**: `filename.includes(dir)` для игнора — false-positive на именах типа `my_dist_utils.ts`.
- **`walker.ts:99`**: Regex экспортов не ловит multiline (`export const\n  x = ...`).
- **`cache.ts:24`**: `join(cachePath, '..')` вместо `dirname()` — хрупко.

---

## 13. Skills — навыки

Файлы: `src/modules/skills/`

- Загрузка из builtin/global/project директорий (`.md` и `.skill.md` файлы)
- Frontmatter: `name` (required), `description`, `keywords`, `mma_version`
- Бюджет: 10% от contextWindow
- Матчинг: keyword overlap (анти-паттерн, документирован в AGENTS.md #10)

**⚠️ Слабые места:**
- **`loader.ts:65-80`**: YAML-парсер не поддерживает многострочные значения и вложенные объекты.
- **`matcher.ts:19`**: `kw.includes(word)` — false-positive матчинг.
- **`module.ts:104-112`**: Все available skills всегда в системном промпте — без обрезания по бюджету.
- **`module.ts:146`**: Оценка токенов `content.length / 4` вместо использования js-tiktoken.

---

## 14. Plugins — плагины

Файлы: `src/modules/plugins/`

- PluginManager: хранение, сортировка по priority, диспатч хуков с error isolation
- PluginLoader: загрузка `.ts`/`.js` из директорий через `require()`
- lint-on-write: `onAfterTool` → per-file tsc/node-check → debounced project tsc
- notify: `onSessionEnd` → лог

**⚠️ Слабые места:**
- **`lint-on-write.ts:7-8`**: Module-level state для debounce — **шарится между всеми сессиями**.
- **`lint-on-write.ts:39`**: `runProjectTypeCheck` вызывается даже для не-TS файлов.
- **`lint-on-write.ts:104-109`**: При повторном вызове в пределах 2s — join к in-flight проверке. Если она для другого файла — результат вводит в заблуждение.
- **`loader.ts:18`**: `require()` для `.ts` работает только под Bun.
- **`manager.ts:8-10`**: Нет проверки на дубликаты имён плагинов.

---

## 15. Browser — браузер

Файлы: `src/modules/browser/`

- Playwright Chromium, headless
- Accessibility tree snapshot (нумерованный список элементов)
- Действия: open, click, type, scroll, back, forward, screenshot, snapshot, wait, close
- Vision model detection: по подстроке в имени модели
- Cookie persistence: `browser/cookies.json`
- Stuck detection: 3 повторяющихся действия

**⚠️ Слабые места:**
- **`snapshot.ts:43-87`**: Индексы в injection-скрипте и extraction-парсере могут расходиться — неверные цели для click/type.
- **`actions.ts:39-49`**: Index injection пропускает `label[role="button"]` — элемент индексирован но не найден при extraction.
- **`session.ts:25`**: Stuck detection через `JSON.stringify` — порядок ключей влияет на сравнение.
- **`session.ts:272`**: `wait()` хардкожен максимум 10s.

---

## 16. MCP — внешние сервера

Файлы: `src/modules/mcp/`

- JSON-RPC клиент для Model Context Protocol
- Три транспорта: stdio (spawn процесса), SSE (persistent HTTP), HTTP (request-response)
- Авто-обнаружение тулов через `tools/list`
- Неймспейсинг: `mcp__<server>__<tool>`

**⚠️ Слабые места:**
- **`client.ts:139-143`**: `reject()` на `exit` хендлере уже-resolved stdio promise → **unhandled promise rejection**.
- **`client.ts:379-380`**: SSE pending callbacks — singleton, только ОДИН конкурентный вызов.
- **`client.ts:255`**: Нет MCP `initialize` рукопожатия. Сразу `tools/list` — несовместимость со спекой MCP.
- **`client.ts:126`**: `parseMessages` доверяет `Content-Length` без ограничения размера → **потенциальный OOM**.

---

## 17. LSP — языковые сервера

Файлы: `src/modules/lsp/`

- Интеграция с Language Server Protocol через stdio
- Поддержка: TypeScript, JavaScript, Python, Rust, Go, JSON, HTML, CSS
- Плагин `onAfterTool`: после write/edit — spawn LSP → `didOpen` → ждать diagnostics → shutdown

**⚠️ Слабые места:**
- **`client.ts:23-69`**: **Каждый вызов spawn-ит новый LSP сервер**. При 5 записях — 5 spawn/kill cycles. Typescript-language-server стартует 5-15 секунд.
- **`client.ts:44-52`**: `didOpen` без отслеживания открытых документов — повторный `didOpen` на тот же файл отклоняется сервером.
- **`client.ts:126`**: `parseMessages` доверяет Content-Length → OOM риск.
- **`config.ts:11`**: `autoInstall: true` для npx-based серверов — установка пакетов молча при первом использовании.

---

## 18. Security — безопасность

Файлы: `src/modules/security/`

- Phase 1 + Phase 4 реализованы
- Bash command validation (blacklist)
- Path validation (global denied, scope)
- Network validation (domain whitelist/blacklist)
- Content scanning (dangerous patterns)
- Subagent recursion control (max depth 3)
- Audit logging (audit.jsonl)
- Data sanitization (API keys, tokens)
- Session encryption (AES-256-GCM)
- Audit notifications (файл + webhook)
- Security policies (strict, balanced, permissive)

**⚠️ Слабые места:**
- **`security.ts:82`**: `dangerousOperators` не содержит `|`, `;`, `&&` — AGENTS.md утверждает обратное.
- **`security-commands.ts:38-47`**: `security status` не проверяет `security.enabled` — показывает фичи даже когда security отключён.
- **`security-commands.ts:141-148`**: `enable-audit` перезаписывает кастомные настройки хардкоженными дефолтами.
- **`network-validator.ts`**: `maxResponseSize: 15000` (15KB) — экстремально мало для веб-страниц.

---

## 19. Processes — управление процессами

Файлы: `src/modules/processes/`

### 19.1 Process Registry (`registry.ts`)

- `start()`: spawn, отслеживание stdout/stderr, буферизация (до 2000 строк)
- `kill(id)`: taskkill /T /F (Windows) или process group kill (POSIX)
- `killAll()`: вернуть количество убитых
- `waitForExit(id, timeout)`: Promise + таймаут

### 19.2 Kill Runner (`runner.ts`)

- `registerKillable(callId, kill)`: связать вызов с функцией убийства
- `killByCallId(callId)`: executor timeout вызывает принудительное убийство

**⚠️ Слабые места:**
- **`registry.ts:102-103`**: CP866 хардкожен — см. секцию Tools.
- **`registry.ts:163,212-225,243`**: `exitWaiters` не чистятся после завершения процесса — minor memory leak.
- **`runner.ts:18-20`**: Нет гарантии вызова `unregisterKillable` — записи копятся.

---

## 20. UI — рендеринг

Файлы: `src/ui/`

- Renderer: rich (TTY) / plain (pipe/CI) — авто-выбор
- Spinner: braille-фреймы на stderr, 80ms
- Box: ANSI-рамки с авто-шириной
- Table: Markdown → box-drawing таблицы
- Markdown formatter: стриминг, code blocks, bold, italic, strikethrough, links
- Diff: LCS-based, ± строки

**⚠️ Слабые места:**
- **`diff.ts:172-178`**: `Math.max(...[])` возвращает `-Infinity` для pure-add/pure-delete диффов → широкие колонки номеров строк.
- **`md-formatter.ts:206`**: Italic regex не матчит trailing punctuation (`_text_.`).
- **`renderer.ts:178`**: `this.card` не сбрасывается в plain mode → stale object reference.
- **`box.ts:70`**: Заголовок бокса не обрезается при превышении ширины.
- **`table.ts:105-117`**: Переполнение колонок без индикатора обрезания.

---

## 21. Config — конфигурация

Файлы: `src/config/`

- 3 слоя: defaults.ts → `~/.mma/config.json` → `<project>/.mmrc` → env vars
- Шифрование sensitive полей (apiKey) — соль + AES
- `deepMerge` с кастомной обработкой массивов и regex
- Валидация: expert config, security config

**⚠️ Слабые места:**
- **`config.ts:110-112`**: `parseInt(env.MMA_*)` без `isNaN` — NaN при нечисловых значениях.
- **`config.ts:129-136` vs `index.ts:67-77`**: Дубликат миграционной логики с разным поведением.
- **`config.ts:156-161`**: `restoreDangerousPatterns` вызывается ПОСЛЕ deepMerge — восстановление после повреждения при мёрже.
- **`defaults.ts:84`**: `CONTEXT7_API_KEY` читается на import time — не подхватит runtime-изменения.
- **`security.ts:82`**: `dangerousOperators` не совпадает с документацией в AGENTS.md.

---

## 22. I18n — интернационализация

Файлы: `src/i18n/`

- `t(key, params)` — шаблонизация с `{param}` подстановкой
- 510 ключей в en.json и ru.json (идентичные наборы)
- `flatten()` — рекурсивный обход вложенного JSON
- Поддержка смены локали через `setLocale()`

**⚠️ Слабые места:**
- **`index.ts:42-43`**: `||` вместо `??` — **пустые строки переводов** (например, `session.col_active: ""`) возвращают ключ вместо пустой строки.
- **`index.ts:14`**: `flatten()` не проверяет на массивы — итерация по индексам массива при добавлении array-значений.
- **`index.ts:29`**: `setLocale` молча игнорирует невалидные локали.
- Нет плюрализации — хардкоженные plural-формы.
- Множество хардкоженных строк в коде, проходящих мимо `t()` (verifier.ts, planner.ts, stuck-detector.ts).

---

## 23. Сводная таблица багов 

> **Статус после 3 волн исправлений:** ✓ = исправлено (23), ✗ = осталось (~32).

### Критические (приводят к крашам или повреждению данных)

| # | Файл | Строка | Описание |
|---|------|--------|----------|
| C1 | `modules/mcp/client.ts` | 139-143 | `reject()` на exit хендлере resolved promise → unhandled rejection | ✗ |
| C2 | `modules/mcp/client.ts` | 379-380 | SSE pending callbacks — singleton, конкурентные вызовы зависают | ✗ |
| C3 | `modules/mcp/client.ts` | 126 | `Content-Length` без ограничения → потенциальный OOM | ✗ |
| C4 | `modules/lsp/client.ts` | 126 | То же самое — LSP client | ✗ |
| C5 | `ui/diff.ts` | 172-178 | `Math.max(...[])` → `-Infinity`, широкие колонки номеров строк | ✓ |

### Высокие (неверное поведение в типичных сценариях)

| # | Файл | Строка | Описание |
|---|------|--------|----------|
| H1 | `core/bootstrap.ts` | 327 | `restorePlan()` без проверки на свежесть сессии | ✓ |
| H2 | `core/agent.ts` | 727-754 | Final audit gate принуждает продолжать восстановленный план | ✗ |
| H3 | `core/bootstrap.ts` | 404 | Проектные плагины не грузятся (`~/.mma/.mma/plugins`) | ✓ |
| H4 | `core/agent.ts` | 796-816 | `reconfigure()` не обновляет `toolCtx.llmProvider` | ✓ |
| H5 | `core/agent-moe.ts` | 121-133 | `verifyAndMerge()` без try/catch | ✓ |
| H6 | `llm/openai-compat.ts` | 121-123 | `AbortSignal.any()` может отсутствовать в Bun | ✓ |
| H7 | `modules/session/store.ts` | 142-156 | Одна битая строка → потеря всей истории | ✓ |
| H8 | `modules/lsp/client.ts` | 23-69 | LSP spawn/kill на каждый write — экстремальный overhead | ✗ |
| H9 | `modules/plugins/lint-on-write.ts` | 7-8 | Module-level debounce state — шаринг между сессиями | ✓ |
| H10 | `tools/move-file.ts` | 23-27 | Не использует `safeResolvePath()` | ✓ |
| H11 | `tools/subagent.ts` | 139 | Шаринг executor-а с родителем — мутация scope | ✗ |
| H12 | `modules/context/manager.ts` | 281 | `iterationsSinceCompaction` не сбрасывается при раннем возврате | ✓ |
| H13 | `modules/context/manager.ts` | 303 | `extractTriedAndFailed` на pre-compaction массиве | ✓ |
| H14 | `config/config.ts` | 110-112 | `parseInt` без NaN-проверки | ✓ |
| H15 | `modules/mcp/client.ts` | 255 | Нет MCP `initialize` рукопожатия | ✗ |
| H16 | `modules/lsp/client.ts` | 44-52 | `didOpen` без отслеживания открытых документов | ✗ |

### Средние (исправлено 9 из 23, см. F8-F10,F12,F13,F16-F19,F22-F23)

| # | Файл | Строка | Описание |
|---|------|--------|----------|
| M1 | `modules/execution/module.ts` | 262-267 | `todo done` — no-op |
| M2 | `modules/execution/planner.ts` | 60 | Хардкод `ст.` без i18n |
| M3 | `modules/execution/stuck-detector.ts` | 341-370 | `checkOffTrack()` — dead code |
| M4 | `modules/execution/plan-coverage.ts` | 22 | Дубликат `"jsx"` в IGNORED_EXT |
| M5 | `cli/repl.ts` | 300 | Таймер force-exit не сбрасывается |
| M6 | `cli/main.ts` | 105 | Двойной bootstrap на first-run |
| M7 | `cli/repl-commands.ts` | 445 | `/reload` не обновляет configDir/baseDir |
| M8 | `tools/grep-tool.ts` | 53 | Shell injection в fallback |
| M9 | `tools/search-history.ts` | 63 | Всегда `success: true` |
| M10 | `tools/remember.ts` + `recall.ts` | — | Dead code |
| M11 | `modules/browser/snapshot.ts` | 43-87 | Индексы injection vs extraction расходятся |
| M12 | `modules/browser/session.ts` | 25 | Stuck detection — порядок ключей в JSON |
| M13 | `modules/memory/module.ts` | 20 | `.md` память не в системном промпте |
| M14 | `modules/indexer/walker.ts` | 42 | `fs.watch` не рекурсивен на Linux |
| M15 | `modules/indexer/walker.ts` | 43 | `filename.includes(dir)` — false positives |
| M16 | `modules/skills/loader.ts` | 65-80 | YAML парсер неполноценный |
| M17 | `modules/session/store.ts` | 134-139 | O(N²) обновление meta на каждый appendMessage |
| M18 | `modules/hallucination/confidence.ts` | 16 | `MIN_CHARS=1` — проверка только пустой строки |
| M19 | `modules/hallucination/detector.ts` | 34-40 | Short-circuit на retry — factual check пропускается |
| M20 | `processes/registry.ts` | 102-103 | CP866 хардкожен — garbled output |
| M21 | `i18n/index.ts` | 42-43 | Пустые переводы возвращают ключ |
| M22 | `config/security.ts` | 82 | `dangerousOperators` не совпадает с AGENTS.md |
| M23 | `modules/plugins/loader.ts` | 18 | `require()` для .ts — только Bun |

### Низкие (не исправлялись — косметика/потенциальные улучшения)

| # | Файл | Описание |
|---|------|----------|
| L1 | `cli/commands.ts`, `repl.ts`, `repl-commands.ts` | `readVersion()` дублируется 3 раза |
| L2 | `cli/repl.ts:415` | `require()` в ES-модуле |
| L3 | `cli/completer.ts` | 3 провайдера определены но не зарегистрированы |
| L4 | `ui/md-formatter.ts:206` | Italic regex не матчит trailing punctuation |
| L5 | `ui/renderer.ts:178` | `this.card` не сбрасывается в plain mode |
| L6 | `ui/box.ts:70` | Заголовок бокса не обрезается |
| L7 | `ui/table.ts:105-117` | Переполнение колонок без индикатора |
| L8 | `modules/execution/verifier.ts` | Хардкоженные строки без i18n |
| L9 | `modules/indexer/cache.ts:24` | `join(cachePath, '..')` вместо `dirname()` |
| L10 | `modules/plugins/manager.ts:8-10` | Нет проверки на дубликаты |
| L11 | `logger/app-logger.ts:29-33` | `child()` создаёт независимый логгер |
| L12 | `migration/detect.ts:37-50` | `hasOldSessions()`, `hasOldProfile()` — dead code |
| L13 | `llm/response.ts` | Весь файл — неиспользуемый код |
| L14 | `llm/token-counter.ts:9,41` | Всегда gpt-4o encoding |
| L15 | `modules/session/store.ts:217-236` | `rotateOldSessions()` — dead code |
| L16 | `modules/session/session-isolation.ts:133` | `cleanupSessionTempDir()` — no-op |

