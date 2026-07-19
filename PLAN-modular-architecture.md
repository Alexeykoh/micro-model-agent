# План рефакторинга: Модульная архитектура инструментов

**Статус:** В ожидании
**Приоритет:** Высокий
**Цель:** Устранить God Object в `loop.ts`, сделать все инструменты тестируемыми, убрать дублирование

---

## Проблемы

1. `loop.ts` (1065 строк) — делает всё: ReAct-цикл, диспетчеризацию, валидацию, блокировки
2. Нативные инструменты (plan/todo/question/approve/theme/user_profile) НЕ в реестре — обрабатываются if-else в loop.ts
3. Дублированная логика: plan/todo работают и через JSON tool calls, и через bash-алиасы
4. `subagent.ts` (544 строки) перевыполняет весь ReAct-цикл вместо переиспользования
5. `ToolResult` = `BashResult` — все инструменты впихнуты в stdout/stderr/exitCode

---

## Фаза 1: Единый интерфейс ToolHandler (без изменения поведения)

### Задача 1.1: Создать типы `src/tools/types.ts`
- [ ] Определить `ToolContext` (cwd, renderer, quiet, onQuestion)
- [ ] Определить `ToolResult` с расширениями (questionPending, breakLoop)
- [ ] Определить `ToolHandler` интерфейс (name, definition, execute)
- [ ] Определить `ParsedToolCall` тип

### Задача 1.2: Мигрировать FS-инструменты на ToolHandler
- [ ] Обновить `src/tools/fs/types.ts` — добавить ToolHandler имплементацию
- [ ] Для каждого FS-инструмента (12 штук): обернуть существующий handler в ToolHandler
- [ ] Файлы: read-file.ts, write-file.ts, edit-file.ts, list-dir.ts, create-dir.ts, delete-file.ts, copy-file.ts, move-file.ts, file-info.ts, glob-search.ts, grep-search.ts, tree.ts

### Задача 1.3: Мигрировать bash на ToolHandler
- [ ] Обернуть `executeBash` в ToolHandler в `src/tools/bash.ts`

### Задача 1.4: Мигрировать web-инструменты на ToolHandler
- [ ] web-search.ts → ToolHandler
- [ ] web-fetch.ts → ToolHandler

### Задача 1.5: Создать нативные ToolHandler'ы
- [ ] `src/tools/native/plan.ts` — вынести логику plan из loop.ts (строки 598-616)
- [ ] `src/tools/native/todo.ts` — вынести логику todo из loop.ts (строки 617-632)
- [ ] `src/tools/native/question.ts` — вынести логику question из loop.ts (строки 633-647)
- [ ] `src/tools/native/approve.ts` — вынести логику approve из loop.ts (строки 648-661)
- [ ] `src/tools/native/theme.ts` — вынести логику theme из loop.ts (строки 689-759)
- [ ] `src/tools/native/user-profile.ts` — вынести логику user_profile из loop.ts (строки 662-688)

**Результат фазы 1:** Все инструменты реализуют один интерфейс. Поведение не изменено.

---

## Фаза 2: ToolExecutor — единая диспетчеризация

### Задача 2.1: Создать `src/agent/tool-executor.ts`
- [ ] Класс `ToolExecutor` с пайплайном: pre-hooks → execute → post-hooks
- [ ] Перенести логику pre-hook (runPreToolUseHooks) из loop.ts
- [ ] Перенести логику post-hook (runPostToolUseHooks) из loop.ts
- [ ] Перенести блокировку синтаксиса (pendingSyntaxError) из loop.ts
- [ ] Перенести блокировку прямых записей (directWriteStreak) из loop.ts
- [ ] Перенести блокировку множественных записей из loop.ts
- [ ] Перенести обрезку вывода (truncateToolOutput) из loop.ts
- [ ] Перенести уведомление indexer (notifyFileChanged) из registry.ts
- [ ] Перенести инвалидацию кэша system prompt из registry.ts

### Задача 2.2: Упростить `ToolRegistry`
- [ ] Убрать execute() из ToolRegistry (перенесено в ToolExecutor)
- [ ] Оставить только getDefinitions() и isValidTool()
- [ ] Убрать прямые импорты инструментов — получать из ToolHandler'ов

### Задача 2.3: Упростить loop.ts
- [ ] Заменить if-else цепочку (строки 598-900) на вызов `toolExecutor.execute()`
- [ ] Убрать дублированную логику bash-алиасов (строки 797-877)
- [ ] Убрать duplicate imports (всё идёт через ToolExecutor)
- [ ] Ожидаемый результат: loop.ts ~400 строк

**Результат фазы 2:** loop.ts содержит только ReAct-цикл. Все инструменты диспетчеризируются через ToolExecutor.

---

## Фаза 3: Общий ReAct-цикл для основного агента и субагента

### Задача 3.1: Вынести ReAct-цикл в `src/agent/react-loop.ts`
- [ ] Функция `reactLoop()` — общий цикл для обоих агентов
- [ ] Параметры: provider, executor, systemPrompt, messages, maxSteps, abortSignal
- [ ] События: onToolStart, onToolEnd, onStep, onComplete
- [ ] Убрать дублирование контекстной логики из subagent.ts

### Задача 3.2: Рефакторинг `loop.ts`
- [ ] Заменить тело цикла на вызов `reactLoop()`
- [ ] Оставить только специфику основного агента (скилы, компактирование, auto-load)

### Задача 3.3: Рефакторинг `subagent.ts`
- [ ] Заменить `runIsolatedLoop()` на вызов `reactLoop()`
- [ ] Убрать дублированный парсинг tool calls (extractAllToolCalls уже есть)
- [ ] Заменить `require()` на ESM `import`
- [ ] Ожидаемый результат: subagent.ts ~150 строк

### Задача 3.4: Убрать bash-алиасы
- [ ] Убрать обработку `bash plan ...`, `bash todo ...`, `bash question ...`, `bash approve ...` из loop.ts
- [ ] Модель будет вызывать native tool directly, не через bash
- [ ] Обновить system prompt чтобы модель знала о нативных инструментах

**Результат фазы 3:** ReAct-цикл переиспользуется. Нет дублирования между основным агентом и субагентом.

---

## Фаза 4: Тесты

### Задача 4.1: Юнит-тесты ToolExecutor
- [ ] Тест pre-hooks (блокировка, разрешение)
- [ ] Тест post-hooks (синтаксис, indexer)
- [ ] Тест диспетчеризации (все типы инструментов)
- [ ] Тест блокировок (множественные записи, прямые записи)

### Задача 4.2: Юнит-тесты нативных инструментов
- [ ] Тест plan: create, done, progress, show, clear
- [ ] Тест todo: add, done, remove, list
- [ ] Тест question, approve
- [ ] Тест theme: list, show, switch
- [ ] Тест user_profile: show, add_note

### Задача 4.3: Интеграционные тесты react-loop
- [ ] Тест завершения без tool calls (один ответ LLM)
- [ ] Тест одного tool call + продолжение
- [ ] Тест maxSteps лимита
- [ ] Тест abort signal

### Задача 4.4: Рефакторинг существующих тестов
- [ ] Обновить `tests/plan-todo-memory.test.ts` — использовать ToolExecutor
- [ ] Обновить `tests/subagent.test.ts` — проверить парсинг после рефакторинга
- [ ] Проверить что все тесты проходят

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
- `tests/tool-executor.test.ts` — тесты диспетчера
- `tests/native-tools.test.ts` — тесты нативных инструментов
- `tests/react-loop.test.ts` — тесты общего цикла

### Изменяемые файлы
- `src/agent/loop.ts` — упрощение с 1065 до ~400 строк
- `src/tools/registry.ts` — упрощение, убрать execute()
- `src/tools/subagent.ts` — упрощение с 544 до ~150 строк
- `src/tools/bash.ts` — обёртка в ToolHandler
- `src/tools/web-search.ts` — обёртка в ToolHandler
- `src/tools/web-fetch.ts` — обёртка в ToolHandler
- `src/tools/fs/*.ts` (12 файлов) — обёртка в ToolHandler
- `tests/plan-todo-memory.test.ts` — обновление
- `tests/subagent.test.ts` — обновление

---

---

## Фаза 5: ModeRegistry — единый API режимов и оркестрации

### Проблема

Сейчас режимы работы (fast/base/pro) размазаны по 4 файлам (`types.ts`, `system-prompt.ts`, `loop.ts`, `repl/index.ts`). Поведенческие блокировки (plan enforcement, write streak, single-write) — хардкод в loop.ts. Subagent всегда работает в `base` режиме. Нет способа создать новый режим без изменения ядра.

### Задача 5.1: Создать `src/agent/modes/types.ts`
- [ ] Определить `ModeConfig` интерфейс:
  ```typescript
  interface ModeConfig {
    id: string;                    // 'fast' | 'base' | 'pro' | custom
    label: string;                 // отображаемое имя
    systemPromptTemplate: 'fast' | 'base' | 'pro';
    maxSkills: number;             // 0 = безлимит
    skillTokenBudget: number;
    forcedSkills: string[];        // принудительная загрузка
    allowAutoLoadSkills: boolean;
    minContextWindow: number;      // минимальный контекст (0 = не ограничен)
    behaviors: {
      planEnforcement: boolean;
      directWriteStreak: boolean;
      singleWritePerResponse: boolean;
      readConsolidation: boolean;
      continuationNudge: boolean;
      subagentMode: string;        // какой режим наследует subagent
    };
    ui: {
      showThinking: boolean;
      quiet: boolean;
      promptPrefix: string;        // "[fast]" / "[pro]" / ""
    };
  }
  ```
- [ ] Определить `ModeRegistry` интерфейс (register, get, list, switch)

### Задача 5.2: Создать `src/agent/modes/registry.ts`
- [ ] Класс `ModeRegistry`:
  - `register(mode: ModeConfig): void` — добавить/переопределить режим
  - `get(id: string): ModeConfig` — получить конфиг
  - `list(): ModeConfig[]` — список всех режимов
  - `getDefault(): string` — id режима по умолчанию
- [ ] Зарегистрировать встроенные режимы: `fast`, `base`, `pro` (с текущим поведением)
- [ ] Загружать кастомные режимы из конфига (`config.modes` в `.mmrc`)

### Задача 5.3: Интегрировать ModeRegistry в `src/agent/modes/applier.ts`
- [ ] Функция `applyMode(config: ModeConfig, context: ModeContext): void`
- [ ] Применяет режим к:
  - `system-prompt.ts` — выбор шаблона + секция `## Mode: <label>`
  - `loop.ts` — выставление поведенческих флагов вместо хардкода
  - `repl/index.ts` — префикс промпта + renderer.setMode()
  - `subagent.ts` — наследование режима (subagentMode)
  - `context.ts` — принудительный minContextWindow

### Задача 5.4: Убрать хардкод режимов из loop.ts
- [ ] Заменить хардкод поведения на чтение `currentModeConfig.behaviors.*`
- [ ] `pendingSyntaxError` — оставить (это не режим, а состояние)
- [ ] `directWriteStreak` — читать `behaviors.directWriteStreak`
- [ ] `plan enforcement` — читать `behaviors.planEnforcement`
- [ ] `single-write-per-response` — читать `behaviors.singleWritePerResponse`
- [ ] `continuation nudge` — читать `behaviors.continuationNudge`
- [ ] `read consolidation` — читать `behaviors.readConsolidation`

### Задача 5.5: Интегрировать с сессиями и CLI
- [ ] Сохранять `mode` в сессию (`src/session/store.ts`)
- [ ] Восстанавливать `mode` при `/resume`
- [ ] CLI флаг `--mode fast|base|pro|custom` для одноразовых промптов
- [ ] Команда `/mode` — теперь просто `modeRegistry.switch(id)`
- [ ] Команда `/mode list` — показать все доступные режимы

### Задача 5.6: Subagent наследует режим
- [ ] Передавать `modeId` от родительского агента в subagent
- [ ] Subagent создаёт свой `ModeRegistry` (или копирует конфиг)
- [ ] Subagent может иметь собственные оверрайды (например, `maxSkills: 0`)

### Задача 5.7: Кастомные режимы через конфиг
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
- [ ] ModeRegistry загружает кастомные режимы при старте
- [ ] Кастомные режимы доступны через `/mode` и `--mode`

**Результат фазы 5:** Все режимы — конфигурируемые объекты. Новый режим = JSON в конфиге + опционально свой шаблон system prompt. Никакого хардкода режимов в loop.ts. Subagent наследует режим. Режим персистентен между сессиями.

---

## Новые файлы (фаза 5)

- `src/agent/modes/types.ts` — тип ModeConfig
- `src/agent/modes/registry.ts` — ModeRegistry
- `src/agent/modes/applier.ts` — applyMode
- `tests/modes.test.ts` — тесты режимов

---

## Изменяемые файлы (фаза 5)

- `src/agent/loop.ts` — читать behaviors из ModeConfig вместо хардкода
- `src/agent/system-prompt.ts` — принимать ModeConfig для шаблона
- `src/repl/index.ts` — `/mode` через ModeRegistry, сохранять в сессию
- `src/repl/commands.ts` — `/mode list` команда
- `src/session/store.ts` — сохранять/восстанавливать mode
- `src/cli.ts` — флаг `--mode`
- `src/tools/subagent.ts` — принимать и наследовать modeId
- `src/config/types.ts` — обновить тип AgentMode на ModeConfig

---

## Порядок выполнения

1. Фаза 1 (типы + миграция инструментов) — не меняет поведение, безопасно
2. Фаза 2 (ToolExecutor) — central dispatch, убирает if-else
3. Фаза 3 (общий react-loop) — убирает дублирование
4. Фаза 4 (тесты) — покрытие нового кода
5. Фаза 5 (ModeRegistry) — унификация режимов, конфигурируемое поведение

Каждую фазу можно отдельно коммитить и тестировать.
