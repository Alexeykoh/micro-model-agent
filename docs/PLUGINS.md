# Плагины MMA

Система плагинов на lifecycle events. Плагины подписываются на события агента и могут модифицировать его поведение, добавлять секции в system prompt, блокировать инструменты и многое другое.

## Содержание

- [Архитектура](#архитектура)
- [События (PluginEvent)](#события-pluginevent)
- [Интерфейс AgentPlugin](#интерфейс-agentplugin)
- [PluginContext](#plugincontext)
- [Манифест](#манифест)
- [Обнаружение и загрузка](#обнаружение-и-загрузка)
- [Конфигурация и активация](#конфигурация-и-активация)
- [CLI и REPL](#cli-и-repl)
- [Создание плагина](#создание-плагина)
- [Встроенные плагины](#встроенные-плагины)
- [Продвинутое использование](#продвинутое-использование)
- [Best practices](#best-practices)

## Архитектура

```
PluginManager (event bus)
  ├── register(plugin)         — регистрация плагина
  ├── activate(name, ctx)      — активация (вызов onActivate)
  ├── on(event, name, handler) — подписка на событие
  ├── emit(event, ...args)     — диспатч события (middleware chain)
  └── emitModify(event, init)  — диспатч с модификацией значения

ToolExecutor
  ├── tool:before → emit()     — до выполнения инструмента
  ├── PluginError → блокировка — инструмент не выполняется
  └── tool:after  → emit()     — после выполнения инструмента
```

**Middleware chain:** каждый обработчик получает результат предыдущего. `void` = пропуск. `PluginError` = блокировка.

**Три типа источников плагинов** с возрастающим приоритетом:

1. **builtin** — `dist/plugins/builtin/` (встроенные)
2. **project** — `.mma/plugins/<name>/` (проектные)
3. **user** — `~/.mma/plugins/<name>/` (пользовательские)

Плагины с одинаковыми именами дедуплицируются: первый зарегистрированный выигрывает.

## События (PluginEvent)

| Событие | Фаза | Описание | Где эмитится |
|---------|------|----------|-------------|
| `agent:init` | Agent lifecycle | Старт сессии агента | — |
| `agent:step` | Agent lifecycle | Каждый шаг ReAct-цикла | — |
| `agent:done` | Agent lifecycle | Задача завершена | `loop.ts` |
| `tool:before` | Tool lifecycle | Перед выполнением инструмента | `tool-executor.ts` |
| `tool:after` | Tool lifecycle | После выполнения инструмента | `tool-executor.ts` |
| `tool:blocked` | Tool lifecycle | Инструмент заблокирован | — |
| `llm:before` | LLM lifecycle | Перед запросом к LLM | — |
| `llm:after` | LLM lifecycle | После ответа LLM | — |
| `prompt:build` | Prompt | Сборка system prompt | — |
| `session:save` | Session | Сохранение сессии | — |
| `session:load` | Session | Загрузка сессии | — |
| `mode:switch` | Mode | Смена режима агента | — |
| `plugin:loaded` | Plugin lifecycle | Плагин загружен | — |
| `plugin:error` | Plugin lifecycle | Ошибка плагина | — |

> События без отметки "Где эмитится" — зарезервированы для будущих версий. Интерфейс позволяет добавлять новые события без изменения плагинов.

## Интерфейс AgentPlugin

```typescript
interface AgentPlugin {
  /** Уникальное имя плагина */
  name: string;
  /** Версия (semver) */
  version?: string;
  /** Человекочитаемое описание */
  description?: string;

  /** Вызывается при активации плагина */
  onActivate?(ctx: PluginContext): void | Promise<void>;
  /** Вызывается при деактивации */
  onDeactivate?(): void | Promise<void>;

  /** Подписка на события (deprecated, подписка через PluginManager.on()) */
  on?(event: PluginEvent, handler: PluginHandler): void;

  /** Добавить секцию в system prompt */
  getPromptSection?(): string | Promise<string>;

  /** Добавить behaviors (параметры поведения агента) */
  getBehaviors?(): Record<string, unknown>;
}
```

## PluginContext

```typescript
interface PluginContext {
  /** Рабочая директория (process.cwd()) */
  cwd: string;
  /** Конфиг плагина — manifest.config + переопределения из .mmrc */
  config: Record<string, unknown>;
  /** Логгер для вывода сообщений */
  logger: PluginLogger;
}

interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}
```

## Манифест

Каждый плагин — это директория с файлом `manifest.json`. Обязательные поля: `name` и `entry`.

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Описание плагина",
  "entry": "index.js",
  "events": ["tool:after"],
  "dependencies": {
    "other-plugin": "^1.0.0"
  },
  "config": {
    "myOption": "defaultValue"
  }
}
```

| Поле | Тип | Обязательное | Описание |
|------|-----|-------------|----------|
| `name` | string | да | Уникальное имя плагина |
| `version` | string | нет | Semver-версия |
| `description` | string | нет | Описание |
| `entry` | string | да | Путь к точке входа (относительно директории плагина) |
| `events` | string[] | нет | Какие события слушает (для оптимизации) |
| `dependencies` | object | нет | Зависимости от других плагинов (зарезервировано) |
| `config` | object | нет | Значения конфига по умолчанию |

## Обнаружение и загрузка

При старте сессии `loadAllPluginsWithInfo()` сканирует три директории:

1. **builtin** — `{dist}/plugins/builtin/`
2. **project** — `.mma/plugins/` (относительно CWD)
3. **user** — `~/.mma/plugins/`

Для каждой поддиректории:
1. Проверяется наличие `manifest.json`
2. Парсится манифест (должен содержать `name` и `entry`)
3. Динамический `import()` точки входа
4. Модуль должен экспортировать фабричную функцию по умолчанию или объект `AgentPlugin`
5. Плагин регистрируется в `PluginManager`

Точка входа загружается через динамический `import()` — поддерживаются `.ts` (через tsx в runtime), `.js`, `.mjs`.

## Конфигурация и активация

### Активация через config

В `.mmrc` или `~/.mma/config.json`:

```json
{
  "agent": {
    "plugins": ["my-plugin", "notify"]
  }
}
```

### Активация через режим (ModeConfig)

```json
{
  "id": "pro",
  "plugins": ["hooks-adapter"]
}
```

Режим `pro` активирует плагин `hooks-adapter` автоматически.

### Порядок активации

1. Плагины из `ModeConfig.plugins` (кастомные режимы)
2. Все builtin-плагины (автоматически)
3. Плагины из `config.agent.plugins`

### Переопределение конфига

Пользователь может переопределить `config` плагина через `.mmrc`:

```json
{
  "plugins": {
    "my-plugin": {
      "myOption": "customValue"
    }
  }
}
```

Эти значения мержатся с `manifest.config` и доступны в `PluginContext.config`.

## CLI и REPL

### CLI

```bash
# Список всех обнаруженных плагинов
mma plugin list

# Создать новый плагин (скаффолд)
mma plugin create <name>
# → Создаёт .mma/plugins/<name>/manifest.json + index.ts
```

### REPL

```
/plugins  — показать плагины: имя, версию, источник, статус (active/inactive)
```

## Создание плагина

### Быстрый старт

```bash
# Скаффолд через CLI
mma plugin create my-plugin

# Или вручную
mkdir -p .mma/plugins/my-plugin
```

### Структура

```
.mma/plugins/my-plugin/
├── manifest.json
└── index.ts
```

### manifest.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Логирует все write_file операции",
  "entry": "index.ts",
  "events": ["tool:after"],
  "config": {
    "logToFile": false
  }
}
```

### index.ts

```typescript
import type { AgentPlugin, PluginContext } from 'micro-models-agent';

export default function createPlugin(): AgentPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',

    async onActivate(ctx: PluginContext) {
      ctx.logger.info('my-plugin: активирован');
    },

    async onDeactivate() {
      console.log('my-plugin: деактивирован');
    },

    getPromptSection() {
      return '## My Plugin\nДобавляет инструкцию в system prompt.';
    },
  };
}
```

> `import type { AgentPlugin, PluginContext } from 'micro-models-agent'` работает, если плагин устанавливается как npm-зависимость проекта. Для плагинов в `.mma/plugins/` используйте относительный путь или установите пакет.

### Регистрация обработчиков событий

Плагин сам не подписывается на события — это делает `loop.ts` через `PluginManager.on()`. Вам нужно добавить код в `loop.ts` (для builtin-плагинов) или использовать механизм, описанный ниже.

Для проектных плагинов подписка происходит в `loop.ts` по имени плагина:

```typescript
// В loop.ts (пример)
if (pluginManager.isActive('my-plugin')) {
  pluginManager.on('tool:after', 'my-plugin', (toolName, args, result) => {
    ctx.logger.info(`my-plugin: tool ${toolName} completed`);
    // Модификация результата невозможна в tool:after (данные уже отправлены модели)
  });
}
```

### Блокировка инструмента

Чтобы заблокировать выполнение инструмента, выбросьте `PluginError` из обработчика `tool:before`:

```typescript
import { PluginError } from 'micro-models-agent';

// В loop.ts
if (pluginManager.isActive('my-blocker')) {
  pluginManager.on('tool:before', 'my-blocker', (toolName, args) => {
    if (toolName === 'bash' && String(args.command).includes('rm -rf')) {
      throw new PluginError('rm -rf запрещён плагином my-blocker');
    }
  });
}
```

## Встроенные плагины

### notify — OS desktop-уведомления

Уведомляет пользователя через нативные toast-уведомления.

**События:** `agent:done`, `tool:blocked`, `tool:after`

**Конфиг:**
```json
{
  "config": {
    "onDone": true,
    "onQuestion": true,
    "onBlocked": true
  }
}
```

**Платформы:**
- Windows — PowerShell balloon tip (через `System.Windows.Forms`)
- macOS — `osascript`
- Linux — `notify-send`

**getPromptSection:**
> Notify Plugin — уведомления о завершении задач автоматические, модель не должна дублировать их текстом.

### lint-on-write — авто-линтер

Автоматически запускает линтер после каждого `write_file`/`edit_file` для `.ts/.tsx/.js/.jsx/.mjs/.cjs` файлов. Результат линтинга добавляется в tool result — модель видит ошибки сразу.

**События:** `tool:after`

**Авто-детект линтера** (по порядку):
1. ESLint (`npx eslint --version`)
2. Biome (`npx @biomejs/biome --version`)
3. Prettier (`npx prettier --version`)

**Конфиг:**
```json
{
  "config": {
    "lintCommand": null,
    "cacheFile": ".lint-detected"
  }
}
```

`lintCommand: null` = авто-детект. Можно указать кастомную команду.

**getPromptSection:**
> Lint-on-Write — ошибки линтинга автоматически прикрепляются к результату инструмента.

### hooks-adapter — совместимость с легаси hooks

Активируется только в режиме `pro`. Оборачивает старую систему `.mma/hooks.json` как плагин. Не добавляет функциональности — только информационный мост.

## Продвинутое использование

### Hot-reload

`enableHotReload()` из `loader.ts` отслеживает изменения точки входа плагина через `fs.watch`:

- 500ms debounce
- Деактивация → перезагрузка → регистрация → callback
- Возвращает cleanup-функцию для остановки watcher'а

Используется в разработке для быстрой итерации.

### PluginManager API

```typescript
class PluginManager {
  register(plugin, source): void;
  activate(name, ctx): Promise<void>;
  deactivate(name): Promise<void>;
  on(event, pluginName, handler): void;
  emit(event, ...args): Promise<T | undefined>;
  emitModify(event, initial, ...args): Promise<T>;
  getPromptSections(): Promise<string[]>;
  getBehaviors(): Promise<Record<string, unknown>>;
  listPlugins(): PluginInfo[];
  isActive(name): boolean;
  has(name): boolean;
}
```

### Система типов

```typescript
type PluginSource = 'builtin' | 'project' | 'user';

interface PluginInfo {
  name: string;
  version?: string;
  description?: string;
  active: boolean;
  events: PluginEvent[];
  source: PluginSource;
}

type PluginHandler<T = unknown> = (...args: any[]) => T | void | Promise<T | void>;

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}
```

### Обработка ошибок

| Фаза | Тип ошибки | Поведение |
|------|-----------|-----------|
| `onActivate` | Любая | Плагин не активируется, лог error |
| `onDeactivate` | Любая | Лог error |
| `tool:before` | `PluginError` | Инструмент блокируется, ошибка пользователю |
| `tool:before` | Любая другая | Лог error, цепь продолжается |
| `tool:after` | Любая | Лог error, ошибка проглатывается |
| `getPromptSection` | Любая | Секция пропускается, лог error |
| `getBehaviors` | Любая | Behaviors не добавляются, лог error |

## Best practices

1. **Именование**: kebab-case (`my-plugin`, `lint-on-write`)
2. **Версионирование**: semver, указывайте в манифесте
3. **Конфиги**: все настраиваемые параметры выносите в `manifest.config` с дефолтами
4. **Логирование**: используйте `ctx.logger`, а не `console.log`
5. **Prompt sections**: короткие, информативные — не дублируйте то, что модель и так знает
6. **Ошибки**: `PluginError` только для осознанной блокировки. Обычные ошибки логируйте через `ctx.logger.error`
7. **Отказоустойчивость**: ваш плагин не должен ломать агента. Ловите исключения
8. **Тестирование**: тестируйте плагин отдельно, мокая `PluginManager`
9. **Документация**: хороший `description` в манифесте помогает при `/plugins`
10. **Избегайте side-эффектов в `tool:after`**: результат уже отправлен модели. Используйте для логирования, уведомлений, аудита
