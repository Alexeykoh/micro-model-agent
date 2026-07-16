# Micro Models Agent (MMA)

LLM агент-харнес для маленьких моделей (Qwen3.5-9B, 32K-64K контекст).

## Статус

Все задачи (M0-M7, P1-P10) выполнены и переведены в статус "На проверке" в Projexify.

## Ключевые решения

- **Стек**: TypeScript/Node.js, ESM (`"type": "module"`)
- **Архитектура**: bash-first — модель вызывает bash через `<tool_call>` в тексте (Hermes format)
- **Провайдеры**: только OpenAI-совместимые API (LM Studio, Ollama, vLLM, Together). Прямой REST.
- **Tool calling**: Hermes format `<tool_call>{"name":"bash","arguments":{"cmd":"..."}}</tool_call>` — не JSON тулы
- **CLI**: `npm run mma` через `tsx src/index.ts`
- **Цель**: Qwen3.5-9B, 32K-64K контекст

## Команды

```bash
npm run mma "запрос"                 # one-shot
npm run mma                          # interactive REPL
npm run mma -- provider list         # список провайдеров
npm run mma -- provider add <n> <u>  # добавить провайдер
npm run mma -- provider remove <n>   # удалить провайдер
npm run mma -- model list            # список моделей
npm run mma -- model add <n> <id> <ctx>  # добавить модель
npm run mma -- model params [n]      # показать параметры
npm run mma -- model set <n> k=v     # изменить параметры
npm run mma -- config show           # показать конфиг
npm run mma -- config reset          # сбросить конфиг
npm run build                        # tsc
npm run dev                          # tsx watch
npm test                             # vitest
```

## Структура

```
src/
├── index.ts            # Точка входа
├── cli.ts              # Commander CLI + subcommands
├── repl.ts             # Interactive REPL
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
│   ├── registry.ts     # Реестр инструментов
│   └── sanitizer.ts    # Безопасность команд
├── agent/
│   ├── loop.ts         # ReAct цикл
│   ├── context.ts      # Менеджер контекста (бюджет, compact)
│   └── memory.ts       # Persistent memory
├── indexer/
│   ├── project-map.ts  # Генерация дерева файлов + exports
│   ├── code-index.ts   # AST-индекс символов (tree-sitter)
│   └── cache.ts        # Кэш индекса (.mma/index/)
├── skills/
│   └── loader.ts       # Загрузка Skills/AGENTS.md
└── session/
    └── store.ts        # Хранилище сессий (.mma/sessions/)
```

## Конвенции

- План утверждён в `PLAN.md` — прежде чем отступать, обосновать
- `.mimocode/` — служебная папка агента, не трогать
- `session-*.md` — логи сессий, не часть проекта
- `research/` — результаты, можно перечитывать при спорных решениях
- `docs/` — документация внешних API
- `AGENTS.md` — периодически обновлять под актуальное состояние проекта
- Язык коммитов и документации — русский (по запросу пользователя)

## Внешние интеграции

| Сервис | Документация | Токен |
|--------|-------------|-------|
| **Projexify** | [`docs/projexify-api.md`](docs/projexify-api.md) | `pxt_ogroc0AvBXZdITpX62ZhJ8uPGgyLwfOStrsASFCU` |
