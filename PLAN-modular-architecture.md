# План рефакторинга: Модульная архитектура инструментов

**Статус:** В ожидании
**Приоритет:** Высокий
**Цель:** Устранить God Object в `loop.ts`, сделать все инструменты тестируемыми, убрать дублирование

---

## Решения grilling-сессии

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | ToolExecutor vs behaviors | ToolExecutor — чистый диспетчер (pre→execute→post→truncate). Behaviors — в loop.ts. Фаза 5 заменяет хардкод на ModeConfig. |
| 2 | question/approve early return | Механизм паузы: цикл приостанавливается, получает ответ, продолжается. ToolResult возвращает `questionPending: true`. |
| 3 | Post-execution логика | ToolExecutor = pre→execute→post→truncate. Domain логика (syntax check, consolidation, plan display) — в loop.ts. |
| 4 | Лимиты truncation | Вынести из хардкода в конфигурируемый источник (ToolExecutor или ModeConfig). |
| 5 | reactLoop() | Минимальный цикл. Ответственность не пересекается — domain логика через callbacks. |
| 6 | doChat() | Перенести в react-loop.ts если связан с циклом напрямую (да — это LLM-вызов). |
| 7 | Bash-aliases | Удалить полностью + обновить system prompt (вариант A). |
| 8 | ModeConfig behaviors | `{ [key: string]: unknown }` с runtime валидацией. Mode = вариант настройки агента. |
| 9 | Mode persistence | base = default. Убрать перезатирание, сохранять mode из сессии в сессию. |
| 10 | grill-me | Специфика мода — `forcedSkills` в ModeConfig. |
| 11 | Pro minContextWindow | `minContextWindow: 64000` как требование (constraints), не опция. |
| 12 | Plugin system | Variant C — lifecycle events. TS через tsx, hot-reload, version optional, no isolation. |

---

## Проблемы

1. `loop.ts` (1065 строк) — делает всё: ReAct-цикл, диспетчеризацию, валидацию, блокировки
2. Нативные инструменты (plan/todo/question/approve/theme/user_profile) НЕ в реестре — обрабатываются if-else в loop.ts
3. Дублированная логика: plan/todo работают и через JSON tool calls, и через bash-алиасы
4. `subagent.ts` (544 строки) перевыполняет весь ReAct-цикл вместо переиспользования
5. `ToolResult` = `BashResult` — все инструменты впихнуты в stdout/stderr/exitCode
6. Режимы (fast/base/pro) хардкод в 4 файлах, нет способа создать новый без изменения ядра

---

## Фаза 1: Единый интерфейс ToolHandler (без изменения поведения)

### Задача 1.1: Создать типы `src/tools/types.ts`
- [ ] Определить `ToolContext` (cwd, renderer, quiet, onQuestion)
- [ ] Определить `ToolResult` с расширениями (questionPending, breakLoop)
- [ ] Определить `ToolHandler` интерфейс (name, definition, execute)
- [ ] Определить `ParsedToolCall` тип

### Задача 1.2: Мигрировать FS-инструменты на ToolHandler
- [ ] Для каждого FS-инструмента (12 штук): обернуть существующий handler в ToolHandler
- [ ] Pattern: `async execute(args, ctx) { return handleReadFile(args, ctx.cwd); }`
- [ ] Файлы: read-file.ts, write-file.ts, edit-file.ts, list-dir.ts, create-dir.ts, delete-file.ts, copy-file.ts, move-file.ts, file-info.ts, glob-search.ts, grep-search.ts, tree.ts

### Задача 1.3: Мигрировать bash на ToolHandler
- [ ] Обернуть `executeBash` в ToolHandler в `src/tools/bash.ts`

### Задача 1.4: Мигрировать web-инструменты на ToolHandler
- [ ] web-search.ts → ToolHandler
- [ ] web-fetch.ts → ToolHandler

### Задача 1.5: Создать нативные ToolHandler'ы
- [ ] `src/tools/native/plan.ts` — вынести логику plan из loop.ts
- [ ] `src/tools/native/todo.ts` — вынести логику todo из loop.ts
- [ ] `src/tools/native/question.ts` — вынести логику question (возвращает `questionPending: true`)
- [ ] `src/tools/native/approve.ts` — вынести логику approve (возвращает `questionPending: true`)
- [ ] `src/tools/native/theme.ts` — вынести логику theme из loop.ts
- [ ] `src/tools/native/user-profile.ts` — вынести логику user_profile из loop.ts

**Результат фазы 1:** Все инструменты реализуют один интерфейс. Поведение не изменено.

---

## Фаза 2: ToolExecutor — единая диспетчеризация

**Принцип:** ToolExecutor — чистый диспетчер. Никакой domain-логики.

### Задача 2.1: Создать `src/agent/tool-executor.ts`
- [ ] Класс `ToolExecutor` с пайплайном: `pre-hooks → execute → post-hooks → truncate`
- [ ] Перенести `runPreToolUseHooks()` из loop.ts → pre-hook
- [ ] Перенести `runPostToolUseHooks()` из loop.ts → post-hook
- [ ] Перенести `truncateToolOutput()` → truncate (лимиты вынести из хардкода)
- [ ] Перенести `notifyFileChanged` + `invalidateSystemPromptCache` из registry.ts → post-hook
- [ ] Вернуть `{ result: ToolResult, breakLoop?: boolean }` — loop.ts проверяет breakLoop

### Задача 2.2: Упростить `ToolRegistry`
- [ ] Убрать `execute()` из ToolRegistry (перенесено в ToolExecutor)
- [ ] Оставить только `getDefinitions()` и `isValidTool()`

### Задача 2.3: Упростить loop.ts
- [ ] Заменить if-else цепочку на вызов `toolExecutor.execute()`
- [ ] Оставить domain-логику в loop.ts:
  - `pendingSyntaxError` — блокировка записей
  - `directWriteStreak` — escalation
  - `read_file` consolidation
  - Syntax checking после write
  - Plan/todo auto-display
  - `autoLearnFromError()`
- [ ] Обработать `result.breakLoop` для question/approve
- [ ] Ожидаемый результат: loop.ts ~500 строк (было 1065)

### Задача 2.4: Вынести лимиты truncation
- [ ] Перенести `LIMITS` record из loop.ts в ToolExecutor или конфиг
- [ ] Сделать переопределяемым через ModeConfig или AgentConfig

**Результат фазы 2:** ToolExecutor — чистый диспетчер. loop.ts — ReAct-цикл + domain-логика.

---

## Фаза 3: Общий ReAct-цикл для основного агента и субагента

**Принцип:** `reactLoop()` — минимальный цикл. Ответственность не пересекается.

### Задача 3.1: Вынести ReAct-цикл в `src/agent/react-loop.ts`
- [ ] Функция `reactLoop()` — общий цикл для обоих агентов
- [ ] Параметры: provider, toolExecutor, systemPrompt, messages, maxSteps, abortSignal
- [ ] Callbacks: `onToolStart`, `onToolEnd`, `onStep`, `onComplete`, `onPause` (для question/approve)
- [ ] Перенести `doChat()` сюда (связан с циклом напрямую)
- [ ] Минимальный: while loop + LLM call + tool dispatch + token counting + compaction
- [ ] **Без** domain-логики (skills, syntax check, consolidation — через callbacks)

### Задача 3.2: Рефакторинг `loop.ts`
- [ ] Заменить тело цикла на вызов `reactLoop()`
- [ ] Зарегистрировать callbacks для domain-логики:
  - `onToolEnd` → syntax check, consolidation, plan display, error learning
  - `onPause` → question/approve pause mechanism
- [ ] Оставить: skills loading, auto-load, skill budget, system prompt building

### Задача 3.3: Рефакторинг `subagent.ts`
- [ ] Заменить `runIsolatedLoop()` на вызов `reactLoop()`
- [ ] Убрать дублированный `extractAllToolCalls()` (уже есть в loop.ts)
- [ ] Заменить `require()` на ESM `import`
- [ ] Передавать `modeId` от родительского агента
- [ ] Ожидаемый результат: subagent.ts ~150 строк

### Задача 3.4: Убрать bash-алиасы (ПОЛНОСТЬЮ)
- [ ] Убрать обработку `bash plan ...`, `bash todo ...`, `bash question ...`, `bash approve ...`
- [ ] Обновить system prompt: модель знает о нативных инструментах
- [ ] **Breaking change для маленьких моделей** — принят

### Задача 3.5: Механизм паузы для question/approve
- [ ] `reactLoop()` поддерживает состояние `paused`
- [ ] При `questionPending: true` — цикл приостанавливается, возвращает управление
- [ ] При получении ответа — цикл продолжается с нового шага
- [ ] Реализация: `onPause` callback + внешний цикл в loop.ts/subagent.ts

**Результат фазы 3:** ReAct-цикл переиспользуется. Нет дублирования. Bash-алиасы удалены.

---

## Фаза 4: Тесты

### Задача 4.1: Юнит-тесты ToolExecutor
- [ ] Тест pre-hooks (блокировка, разрешение)
- [ ] Тест post-hooks (indexer, cache invalidation)
- [ ] Тест диспетчеризации (все типы инструментов)
- [ ] Тест truncation (лимиты, per-tool)

### Задача 4.2: Юнит-тесты нативных инструментов
- [ ] Тест plan: create, done, progress, show, clear
- [ ] Тест todo: add, done, remove, list
- [ ] Тест question: возвращает questionPending
- [ ] Тест approve: возвращает questionPending
- [ ] Тест theme: list, show, switch
- [ ] Тест user_profile: show, add_note

### Задача 4.3: Интеграционные тесты react-loop
- [ ] Тест завершения без tool calls (один ответ LLM)
- [ ] Тест одного tool call + продолжение
- [ ] Тест maxSteps лимита
- [ ] Тест abort signal
- [ ] Тест pause/resume (question/approve)

### Задача 4.4: Рефакторинг существующих тестов
- [ ] Обновить `tests/plan-todo-memory.test.ts`
- [ ] Обновить `tests/subagent.test.ts`
- [ ] Проверить что все тесты проходят

---

## Фаза 5: ModeRegistry — конфигурируемые режимы

**Принцип:** Mode = вариант настройки агента. `{ [key: string]: unknown }` behaviors. Runtime валидация.

### Задача 5.1: Создать `src/agent/modes/types.ts`
- [ ] Определить `ModeConfig` интерфейс:
  ```typescript
  interface ModeConfig {
    id: string;                    // 'fast' | 'base' | 'pro' | custom
    label: string;                 // отображаемое имя
    systemPromptTemplate: string;  // ключ шаблона
    constraints: {
      maxSkills: number;           // 0 = безлимит
      skillTokenBudget: number;
      minContextWindow: number;    // pro = 64000 (требование)
    };
    forcedSkills: string[];        // принудительная загрузка (grill-me для pro)
    allowAutoLoadSkills: boolean;
    behaviors: Record<string, unknown>;  // planEnforcement, directWriteStreak, etc.
    ui: {
      showThinking: boolean;
      quiet: boolean;
      promptPrefix: string;        // "[fast]" / "[pro]" / ""
    };
  }
  ```
- [ ] Определить `ModeRegistry` интерфейс (register, get, list, getDefault)

### Задача 5.2: Создать `src/agent/modes/registry.ts`
- [ ] Класс `ModeRegistry`:
  - `register(mode: ModeConfig): void`
  - `get(id: string): ModeConfig`
  - `list(): ModeConfig[]`
  - `getDefault(): string`
- [ ] Зарегистрировать встроенные: `fast`, `base`, `pro`
- [ ] Загружать кастомные из `.mmrc` (`config.modes`)
- [ ] `extends` поддержка: кастомные режимы наследуют и переопределяют

### Задача 5.3: Создать `src/agent/modes/applier.ts`
- [ ] Функция `applyMode(config: ModeConfig, context: ModeContext): void`
- [ ] Применяет к: system-prompt, loop.ts (behaviors), repl (prefix), subagent (modeId)

### Задача 5.4: Убрать хардкод из loop.ts
- [ ] Заменить хардкод поведения на чтение `currentModeConfig.behaviors[key]`
- [ ] `pendingSyntaxError` — оставить (это состояние, не режим)
- [ ] `directWriteStreak` — behaviors
- [ ] `plan enforcement` — behaviors
- [ ] `single-write-per-response` — behaviors
- [ ] `continuation nudge` — behaviors
- [ ] `read consolidation` — behaviors

### Задача 5.5: Персистентность mode
- [ ] Сохранять `mode` в `Session` (`src/session/store.ts`)
- [ ] Восстанавливать при `/resume`
- [ ] **base = default**, но mode сохраняется между сессиями (убрать перезатирание)
- [ ] CLI флаг `--mode` для одноразовых промптов
- [ ] `/mode` через `modeRegistry.switch(id)`
- [ ] `/mode list` — показать доступные

### Задача 5.6: Subagent наследует режим
- [ ] Передавать `modeId` от родительского агента
- [ ] Subagent получает копию ModeConfig (не registry)
- [ ] Subagent может иметь оверрайды (например, `maxSkills: 0`)

### Задача 5.7: Кастомные режимы
- [ ] Секция `modes` в `.mmrc`:
  ```json
  {
    "modes": {
      "my-mode": {
        "extends": "base",
        "behaviors": { "planEnforcement": false },
        "ui": { "promptPrefix": "[my]" }
      }
    }
  }
  ```
- [ ] ModeRegistry загружает при старте
- [ ] Доступны через `/mode` и `--mode`

### Задача 5.8: Убрать мёртвый код
- [ ] Убрать `config.mode` из `config/types.ts` (поле определено но никогда не читается)
- [ ] Убрать хардкод `['fast', 'base', 'pro']` в repl/index.ts — читать из registry
- [ ] Убрать пустой handler в commands.ts — инжектить из index.ts

**Результат фазы 5:** Mode = конфигурируемый объект. Новый режим = JSON. Behaviors = `{ [key]: unknown }`. Mode персистентен. Subagent наследует.

---

## Фаза 6: Plugin System — Lifecycle Events

**Принцип:** Variant C — event-based lifecycle. Плагин подписывается на события, ядро диспатчит. Новые события добавляются без изменения интерфейса плагина.

### Задача 6.1: Создать `src/plugins/types.ts`
- [ ] Определить `PluginEvent` — все события системы:
  ```
  agent:init          — инициализация агента
  agent:step          — начало шага ReAct
  agent:done          — завершение цикла
  
  tool:before         — перед выполнением инструмента (middleware: может изменить args)
  tool:after          — после выполнения (middleware: может изменить result)
  tool:blocked        — инструмент заблокирован (hooks/syntax error)
  
  llm:before          — перед LLM-вызовом (middleware: может изменить messages)
  llm:after           — после LLM-вызова (middleware: может изменить response)
  
  prompt:build        — сборка system prompt (aggregation: добавить секцию)
  
  session:save        — сохранение сессии
  session:load        — загрузка сессии
  
  mode:switch         — смена режима
  plugin:loaded       — плагин загружен
  plugin:error        — ошибка в плагине
  ```
- [ ] Определить `PluginHandler` тип — `(...args) => T | void | Promise<T | void>`
- [ ] Определить `PluginContext` интерфейс (cwd, config, logger)
- [ ] Определить `PluginLogger` интерфейс (info, warn, error, debug)
- [ ] Определить `PluginError` класс — для блокировки инструментов
- [ ] Определить `AgentPlugin` интерфейс:
  ```typescript
  interface AgentPlugin {
    name: string;
    version?: string;                    // optional
    onActivate?(ctx: PluginContext): void | Promise<void>;
    onDeactivate?(): void | Promise<void>;
    on?(event: PluginEvent, handler: PluginHandler): void;
    getPromptSection?(): string | Promise<string>;
    getBehaviors?(): Record<string, unknown>;
  }
  ```

### Задача 6.2: Создать `src/plugins/manager.ts`
- [ ] Класс `PluginManager`:
  - `register(plugin: AgentPlugin): void` — зарегистрировать
  - `unregister(name: string): void` — удалить
  - `on(event, handler)` — подписка (для middleware: handler возвращает T | void)
  - `emit(event, ...data)` — диспатч с поддержкой middleware chain
  - `emitAsync(event, ...data)` — async версия
  - `getPromptSections(): string[]` — агрегация от всех плагинов
  - `getBehaviors(): Record<string, unknown>` — агрегация behaviors
  - `listPlugins(): PluginInfo[]`
- [ ] Middleware chain: каждый handler получает результат предыдущего. `void` = пропуск. `PluginError` = блокировка.
- [ ] Error isolation: ошибка в одном плагине не ломает другие (log + continue)

### Задача 6.3: Создать `src/plugins/loader.ts`
- [ ] Discovery директорий:
  - `~/.mma/plugins/` — глобальные
  - `.mma/plugins/` — проектные
- [ ] Загрузка `manifest.json` + entry point (TypeScript через `tsx`)
- [ ] Hot-reload: `fs.watch` на директорию плагина, при изменении — deactivate → reload → activate
- [ ] Валидация manifest: name, entry, hooks (optional)
- [ ] Конфиг плагина: `manifest.config` + override из `.mmrc` → `plugins.<name>.config`

### Задача 6.4: Интегрировать PluginManager в ядро
- [ ] **ToolExecutor** (фаза 2): emit `tool:before` → execute → emit `tool:after`
- [ ] **react-loop** (фаза 3): emit `llm:before` → LLM call → emit `llm:after`
- [ ] **system-prompt.ts**: `pluginManager.getPromptSections()` → добавить в prompt
- [ ] **ModeRegistry** (фаза 5): `mode.plugins: string[]` → activate/deactivate при switch
- [ ] **Session store**: emit `session:save` / `session:load`

### Задача 6.5: Адаптер для существующих hooks
- [ ] `src/plugins/adapters/hooks-adapter.ts` — оборачивает `.mma/hooks.json` как плагин
- [ ] preToolUse → `tool:before` handler
- [ ] postToolUse → `tool:after` handler
- [ ] postEdit → `tool:after` handler (фильтр по tool name)
- [ ] При миграции: hooks из конфига автоматически оборачиваются в плагин

### Задача 6.6: CLI для плагинов
- [ ] `mma plugin list` — список установленных
- [ ] `mma plugin create <name>` — scaffolding (manifest.json + index.ts)
- [ ] `mma plugin info <name>` — информация о плагине
- [ ] `mma plugin enable/disable <name>` — включение/выключение

### Задача 6.7: Тесты
- [ ] Тест PluginManager: register/unregister, emit, middleware chain, error isolation
- [ ] Тест loader: discovery, hot-reload, manifest validation
- [ ] Тест hooks-adapter: переход hooks → plugin
- [ ] Тест интеграции: plugin блокирует инструмент, plugin модифицирует args/result

### Среда выполнения
- TypeScript через `tsx` (без compile step)
- Hot-reload: `fs.watch` → deactivate → reload module → activate
- Изоляция: пока нет (shared process)
- Версия manifest: optional

**Результат фазы 6:** Единая система расширений. Плагин = event subscriber. Новые события = без изменения ядра. Hooks мигрируются как плагин. Hot-reload для разработки.

---

## Файлы для изменения/создания

### Новые файлы
- `src/tools/types.ts` — общие типы
- `src/tools/native/plan.ts` — нативный инструмент plan
- `src/tools/native/todo.ts` — нативный инструмент todo
- `src/tools/native/question.ts` — нативный инструмент question
- `src/tools/native/approve.ts` — нативный инструмент approve
- `src/tools/native/theme.ts` — нативный инструмент theme
- `src/tools/native/user-profile.ts` — нативный инструмент user_profile
- `src/agent/tool-executor.ts` — диспетчер инструментов
- `src/agent/react-loop.ts` — общий ReAct-цикл
- `src/agent/modes/types.ts` — тип ModeConfig
- `src/agent/modes/registry.ts` — ModeRegistry
- `src/agent/modes/applier.ts` — applyMode
- `src/plugins/types.ts` — типы плагинов (AgentPlugin, PluginEvent, PluginContext)
- `src/plugins/manager.ts` — PluginManager (event bus + middleware chain)
- `src/plugins/loader.ts` — discovery, загрузка, hot-reload
- `src/plugins/adapters/hooks-adapter.ts` — миграция hooks → plugin
- `tests/tool-executor.test.ts`
- `tests/native-tools.test.ts`
- `tests/react-loop.test.ts`
- `tests/modes.test.ts`
- `tests/plugins.test.ts`

### Изменяемые файлы
- `src/agent/loop.ts` — с 1065 до ~500 строк (ReAct + domain callbacks)
- `src/tools/registry.ts` — убрать execute()
- `src/tools/subagent.ts` — с 544 до ~150 строк
- `src/tools/bash.ts` — обёртка в ToolHandler
- `src/tools/web-search.ts` — обёртка в ToolHandler
- `src/tools/web-fetch.ts` — обёртка в ToolHandler
- `src/tools/fs/*.ts` (12 файлов) — обёртка в ToolHandler
- `src/agent/system-prompt.ts` — принимать ModeConfig + plugin sections
- `src/repl/index.ts` — mode через ModeRegistry, сохранять в сессию
- `src/repl/commands.ts` — `/mode list`, `plugin list`
- `src/session/store.ts` — поле mode в Session, plugin events
- `src/cli.ts` — флаг `--mode`, `plugin` subcommand
- `src/config/types.ts` — убрать мёртвый `AgentMode`, добавить plugins секцию
- `tests/plan-todo-memory.test.ts`
- `tests/subagent.test.ts`

---

## Порядок выполнения

1. **Фаза 1** (типы + миграция инструментов) — не меняет поведение, безопасно
2. **Фаза 2** (ToolExecutor) — central dispatch, убирает if-else
3. **Фаза 3** (общий react-loop) — убирает дублирование, удаляет bash-aliases
4. **Фаза 4** (тесты) — покрытие нового кода
5. **Фаза 5** (ModeRegistry) — унификация режимов, конфигурируемое поведение
6. **Фаза 6** (Plugin System) — lifecycle events, расширяемость

Каждую фазу можно отдельно коммитить и тестировать.

**Зависимости фаз:**
- Фаза 1 → Фаза 2 (ToolExecutor использует ToolHandler)
- Фаза 2 → Фаза 3 (react-loop использует ToolExecutor)
- Фаза 4 → после фаз 1-3 (тесты покрывают новый код)
- Фаза 5 → после фазы 3 (ModeConfig behaviors заменяют хардкод в loop.ts)
- Фаза 6 → после фаз 2+3+5 (PluginManager интегрируется в ToolExecutor, react-loop, ModeRegistry)
