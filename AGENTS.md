# MMA — MiMo Agent

Зелёное поле. Проект LLM агента-харнеса для маленьких моделей (Qwen3.5-9B, 32K-64K контекст).

## Статус

Кода нет. Только исследования (`/research/`) и план (`PLAN.md`). Фаза pre-code.

## Ключевые решения

- **Стек**: TypeScript/Node.js, ESM (`"type": "module"`)
- **Архитектура**: bash-first — один инструмент `bash` вместо дюжины JSON-тулов. Модель пишет команды plain text.
- **Провайдеры**: только OpenAI-совместимые API (Ollama, vLLM, Together). Прямой REST, без Vercel AI SDK.
- **CLI**: команда `MMA` через `tsx src/index.ts`
- **Цель**: Qwen3.5-9B, 32K-64K контекст

## Команды (когда появится код)

```bash
npm run mma -- --model qwen3.5:9b "запрос"
npm run build    # tsc
npm run dev      # tsx watch
```

## Структура (целевая, из PLAN.md)

```
src/
├── index.ts          # CLI entry
├── cli.ts            # commander
├── agent/
│   ├── loop.ts       # ReAct цикл
│   ├── context.ts    # бюджет токенов, auto-compact
│   └── memory.ts     # persistent state
├── llm/
│   ├── provider.ts   # интерфейс
│   ├── openai-compat.ts
│   └── token-counter.ts
├── tools/
│   ├── bash.ts       # безопасность, timeout, обрезка
│   ├── sanitizer.ts  # санитайзер команд
│   ├── mcp.ts
│   └── registry.ts
├── indexer/
│   ├── project-map.ts    # дерево файлов + exports
│   ├── code-index.ts     # AST-индекс символов
│   └── cache.ts          # кэш индекса
├── skills/
│   ├── loader.ts
│   └── store.ts
└── config/
    ├── config.ts
    └── types.ts
```

## Подход к реализации

8 фаз (P0-P7). P0 — каркас проекта. P1 — минимальный ReAct цикл (CLI + bash + OpenAI-compat). Каждая фаза — атомарна.

## Конвенции

- План утверждён в `PLAN.md` — прежде чем отступать от него, обосновать
- `.mimocode/` — служебная папка агента, не трогать
- `session-*.md` — логи сессий, не часть проекта
- `research/` — результаты, можно перечитывать при спорных решениях
- Язык коммитов и документации — русский (по запросу пользователя)
