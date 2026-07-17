# Micro Models Agent (MMA)

LLM агент-харнес для маленьких моделей (Qwen3.5-9B, 32K-64K контекст).

## Статус

Все задачи (M0-M7, P1-P10) выполнены и переведены в статус "На проверке" в Projexify.

## Ключевые решения

- **Стек**: TypeScript/Node.js, ESM (`"type": "module"`)
- **Архитектура**: fs-tools-first — модель вызывает专用ные файловые инструменты через `<tool_call>` (Hermes format). Bash только для非-файловых операций (npm, git).
- **Провайдеры**: только OpenAI-совместимые API (LM Studio, Ollama, vLLM, Together). Прямой REST.
- **Tool calling**: Hermes format `<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>` — не JSON тулы
- **CLI**: `npm run mma` через `tsx src/index.ts`
- **Цель**: Qwen3.5-9B, 32K-64K контекст

## Установка

```bash
npm install -g mma              # глобально из npm
npm link                        # или локально из repo
```

После установки команда `mma` доступна глобально.

## Команды

```bash
mma "запрос"                     # one-shot
mma                              # interactive readline (по умолчанию)
mma --provider ollama --model qwen3.5:9b  # с выбором
mma provider list                # список провайдеров
mma provider add <n> <u>        # добавить провайдер
mma provider remove <n>         # удалить провайдер
mma model list                   # список моделей
mma model add <n> <id> <ctx>    # добавить модель
mma model params [n]            # показать параметры
mma model set <n> k=v           # изменить параметры
mma config show                  # показать конфиг
mma config reset                 # сбросить конфиг
npm run build                    # tsc
npm run dev                      # bun --watch
npm test                         # vitest (unit: context, sanitizer, code-index, file-loader, commands)
```

## Структура

```
src/
├── index.ts            # Точка входа
├── cli.ts              # Commander CLI + program.action (~100 строк)
├── cli/                # CLI subcommands
│   ├── provider.ts     # provider list/use/add/remove
│   ├── model.ts        # model list/use/add/remove/params/set
│   └── config.ts       # config show/reset
├── repl/
│   ├── index.ts        # runRepl() — основной цикл REPL
│   ├── commands.ts     # Реестр slash-команд + handlers
│   └── history.ts      # ConversationHistory — управление историей
├── file-loader.ts      # @file парсинг
├── config/
│   ├── config.ts       # Загрузка/сохранение конфига
│   └── types.ts        # Типы
├── llm/
│   ├── provider.ts     # Интерфейс LLMProvider
│   ├── openai-compat.ts # OpenAI-совместимый провайдер
│   └── token-counter.ts # js-tiktoken + fallback
├── tools/
│   ├── bash.ts         # Выполнение команд + обрезка
│   ├── registry.ts     # Реестр инструментов (bash + fs tools)
│   ├── sanitizer.ts    # Безопасность команд
│   ├── plan.ts         # Управление планами
│   ├── todo.ts         # Список задач
│   ├── question.ts     # Вопросы пользователю
│   ├── approve.ts      # Запрос одобрения
│   ├── hooks.ts        # Pre/post хуки
│   ├── mcp.ts          # MCP интеграция
│   ├── syntax-check.ts # Проверка синтаксиса
│   └── fs/             # Файловые инструменты (12 шт)
│       ├── types.ts        # Типы FsToolResult
│       ├── path-utils.ts   # Утилиты путей, безопасность
│       ├── read-file.ts    # Чтение файлов с нумерацией строк
│       ├── write-file.ts   # Атомарная запись/создание
│       ├── edit-file.ts    # Find & replace
│       ├── list-dir.ts     # Список директорий
│       ├── create-dir.ts   # Создание директорий
│       ├── delete-file.ts  # Удаление файлов/директорий
│       ├── copy-file.ts    # Копирование
│       ├── move-file.ts    # Перемещение/переименование
│       ├── file-info.ts    # Метаданные файла
│       ├── glob-search.ts  # Поиск по паттерну
│       ├── grep-search.ts  # Поиск по regex
│       └── tree.ts         # Дерево директорий
├── agent/
│   ├── loop.ts         # ReAct цикл (~517 строк, без NullRenderer)
│   ├── system-prompt.ts # Системный промпт + константы
│   ├── context.ts      # Менеджер контекста (бюджет, compact)
│   └── memory.ts       # Persistent memory
├── indexer/
│   ├── project-map.ts  # Генерация дерева файлов + exports
│   ├── code-index.ts   # AST-индекс символов (tree-sitter)
│   └── cache.ts        # Кэш индекса (.mma/index/)
├── skills/
│   └── loader.ts       # Загрузка Skills/AGENTS.md
├── ui/
│   ├── index.ts            # Factory: createRenderer(mode)
│   ├── renderer.ts         # OutputRenderer interface + types
│   ├── readline-renderer.ts # console.log/process.stdout обёртка
│   └── components/
│       ├── status-bar.ts   # Форматирование строки статуса
│       └── diff-view.ts    # Парсинг/форматирование diff
├── styling/
│   ├── index.ts        # getTheme() / initTheme()
│   ├── engine.ts       # ThemeEngine
│   ├── loader.ts       # Theme loading
│   └── types.ts        # ThemeConfig, etc.
└── session/
    └── store.ts        # Хранилище сессий (.mma/sessions/)
```

## Файловые инструменты

Модель вызывает专用ные инструменты через ``<tool_call>` формат вместо bash-команд:

| Инструмент | Описание | Пример |
|------------|----------|--------|
| `read_file` | Чтение файла с нумерацией строк | `{"name":"read_file","arguments":{"path":"src/index.ts"}}` |
| `write_file` | Атомарная запись/создание | `{"name":"write_file","arguments":{"path":"file.ts","content":"..."}}` |
| `edit_file` | Find & replace (точное совпадение) | `{"name":"edit_file","arguments":{"path":"file.ts","old_string":"old","new_string":"new"}}` |
| `list_dir` | Список директории | `{"name":"list_dir","arguments":{"path":"src"}}` |
| `create_dir` | Рекурсивное создание | `{"name":"create_dir","arguments":{"path":"src/routes"}}` |
| `delete_file` | Удаление (recursive для dir) | `{"name":"delete_file","arguments":{"path":"old.ts"}}` |
| `copy_file` | Копирование | `{"name":"copy_file","arguments":{"source":"a.ts","destination":"b.ts"}}` |
| `move_file` | Перемещение/переименование | `{"name":"move_file","arguments":{"source":"old.ts","destination":"new.ts"}}` |
| `file_info` | Метаданные файла | `{"name":"file_info","arguments":{"path":"src/index.ts"}}` |
| `glob_search` | Поиск по паттерну | `{"name":"glob_search","arguments":{"pattern":"**/*.ts"}}` |
| `grep_search` | Поиск по regex | `{"name":"grep_search","arguments":{"pattern":"function","include":"*.ts"}}` |
| `tree` | Дерево директорий | `{"name":"tree","arguments":{"depth":2}}` |

**Bash** используется только для非-файловых операций: `npm`, `git`, `docker` и т.д.

## Конвенции

- План утверждён в `PLAN.md` — прежде чем отступать, обосновать
- `.mimocode/` — служебная папка агента, не трогать
- `session-*.md` — логи сессий, не часть проекта
- `research/` — результаты, можно перечитывать при спорных решениях
- `docs/` — документация внешних API
- `AGENTS.md` — периодически обновлять под актуальное состояние проекта
- `src/setup-wizard.ts` — интерактивный мастер первого запуска (выбор провайдера, тест чата, сохранение конфига)
- Язык коммитов и документации — русский (по запросу пользователя)

## Внешние интеграции

| Сервис | Документация | Токен |
|--------|-------------|-------|
| **Projexify** | [`docs/projexify-api.md`](docs/projexify-api.md) | `pxt_ogroc0AvBXZdITpX62ZhJ8uPGgyLwfOStrsASFCU` |
