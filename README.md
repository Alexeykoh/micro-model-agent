# MMA — MiMo Agent

LLM агент-харнес для маленьких моделей (Qwen3.5-9B, 32K-64K контекст).

**Bash-first, JSON-light, small-model-first.**

## Быстрый старт

```bash
# Установка
npm install

# Запустить LM Studio или Ollama с моделью
# LM Studio: http://localhost:1234/v1 (дефолт)
# Ollama:    http://localhost:11434/v1

# One-shot режим
npm run mma "напиши тесты для login.ts"

# Интерактивный REPL
npm run mma
```

## Команды

```bash
npm run mma "запрос"                 # one-shot
npm run mma                          # interactive REPL
npm run mma -- --help                # справка
npm run mma -- provider list         # список провайдеров
npm run mma -- provider use ollama   # переключить провайдера
npm run mma -- model list            # список моделей
npm run mma -- model use qwen3.5:9b  # переключить модель
npm run build                        # tsc
npm run dev                          # tsx watch
npm test                             # vitest
```

## Slash-команды (в REPL)

| Команда | Описание |
|---------|----------|
| `/bash <cmd>` | Выполнить shell команду |
| `/read <file>` | Прочитать файл с номерами строк |
| `/write <file>` | Записать файл (до `EOF`) |
| `/find <pattern>` | Найти файлы по glob |
| `/search <pattern>` | Поиск по содержимому |
| `/git <args>` | Git операции |
| `/memory` | Показать память проекта |
| `/memory show <type>` | Показать тип памяти |
| `/memory add <type> <text>` | Добавить запись |
| `/memory search <query>` | Поиск по памяти |
| `/exit` | Выход |

## `@file` синтаксис

```
@src/auth/login.ts                    — загрузить файл
@src/auth/                            — загрузить всю директорию
@src/index.ts:15                      — конкретная строка
@src/index.ts:10-50                   — диапазон строк
@src/**/*.test.ts                     — glob-паттерн
```

## Конфигурация

Приоритет: флаги CLI > env vars > `.mmrc` (корень проекта) > `~/.mma/config.json` > дефолт.

```bash
export MMA_PROVIDER=ollama
export MMA_MODEL=qwen3.5:9b
```

## Провайдеры

По умолчанию — LM Studio (`http://localhost:1234/v1`). Поддерживаются любые OpenAI-совместимые API:

- LM Studio
- Ollama
- vLLM
- Together AI
- OpenAI

## Память проекта

Автоматически сохраняется в `~/.mma/memory/`:

| Файл | Назначение |
|------|-----------|
| `project.md` | Контекст проекта |
| `conventions.md` | Конвенции кода |
| `decisions.md` | Архитектурные решения |
| `errors.md` | Известные ошибки |
| `history.md` | История изменений |

## Структура проекта

```
src/
├── index.ts            # Точка входа
├── cli.ts              # Commander CLI
├── repl.ts             # Interactive REPL
├── file-loader.ts      # @file парсинг
├── config/
│   ├── config.ts       # Загрузка/сохранение конфига
│   └── types.ts        # Типы конфига
├── llm/
│   ├── provider.ts     # Интерфейс LLMProvider
│   ├── openai-compat.ts # OpenAI-совместимый провайдер
│   └── token-counter.ts # js-tiktoken + fallback
├── tools/
│   ├── bash.ts         # Выполнение команд
│   ├── registry.ts     # Реестр инструментов
│   └── sanitizer.ts    # Безопасность команд
└── agent/
    ├── loop.ts         # ReAct цикл
    ├── context.ts      # Менеджер контекста
    └── memory.ts       # Persistent memory
```

## Фазы реализации

MVP (M0-M7) — реализован. Post-MVP (P1-P9) — в плане:
- P1: Project indexer (project-map + code-index)
- P2: MCP клиент
- P3: Skills / AGENTS.md
- P4: Продвинутая память
- P5: Tree-sitter индексация
- P6: Hooks (PreToolUse, PostToolUse)
- P7: Piped mode
- P8: Advanced context
- P9: Полировка

Подробнее — [PLAN.md](PLAN.md).
