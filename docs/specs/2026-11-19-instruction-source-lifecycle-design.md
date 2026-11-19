# Instruction source lifecycle: живые инструкции, события и источники

**Дата:** 2026-11-19 · **Статус:** target · **Ветка:** `feat/instructions-live-refresh`

## Контекст

`AGENTS.md` — живой источник правил. До этой правки MMA читал его один раз при
bootstrap (`loadAgentsMdBlocks`) и не подхватывал изменения в течение сессии.
OpenCode-подход (инъекция `Instructions updated` в историю) ломает попарность
tool calls у строгих провайдеров и рвёт KV-кеш. MMA применяет изменения на месте.

## Инварианты

1. **INV-IS-1. Перечитывание только на границе хода.** Внутри хода системный
   промпт байтово неизменен (`diffPrompt.cause === "none"`). Чтение разрешено
   только в bootstrap и в `turn-run.ts`.
2. **INV-IS-2. Один system, первым.** Новое содержимое применяется via
   `updateSystemPrompt` — в историю не добавляется новая запись.
3. **INV-IS-3. Изменение видимо в `session.jsonl`.** Событие несёт имена
   изменившихся источников и fingerprint, но не содержимое (INV-13, `source: core`).
4. **INV-IS-4. Все источники имеют владельца.** У каждого instruction-блока
   непустой `source`/`label` (INV-1); замена переполнения сохраняет идентичность.
5. **INV-IS-5. Внешние источники не обходят SSRF-политику.** Пока URL-источники
   не принимаются вовсе (`DEBT(ins-url-sources)`); при реализации — только https
   и только публичные адреса.

## Контракт события `instructions_updated`

```jsonc
{
  "ts": "...",
  "type": "instructions_updated",
  "source": "core",
  "fingerprint": "<sha256-prefix>",
  "changes": [
    { "label": "instructions", "action": "changed" | "added" | "removed" }
  ]
}
```

Содержимое файлов в событии не пишется. Replay обязан tolerate неизвестные ему
типы событий и проверять только структуру.

## Контракт конфига

Новые ключи в домене `instructions` (определения — `registry-extra*.ts`,
значения — `DEFAULTS` в `defaults.ts`):

| Ключ | Тип | Дефолт | Смысл |
|---|---|---|---|
| `instructions.summarize` | bool | `true` | Суммаризация переполнения (уже есть) |
| `instructions.sources` | list | `[]` | Доп. файлы и glob'ы (HTTPS — `DEBT(ins-url-sources)`) |
| `instructions.fallback` | enum | `"claude"` | `CLAUDE.md` там, где нет `AGENTS.md` |

Разрешение путей: относительный — от workspace, `~/` — от дома, абсолютный —
как есть, glob — через `globSync`. HTTPS-источники отложены (синхронный
загрузчик): `DEBT(ins-url-sources)` в `docs/agents/debt.md`.

## Воспроизведение

Правка `AGENTS.md` → событие в логе → следующий ход видит новый текст →
системный промпт внутри хода стабилен. Volны 1–6; приоритет — корректность
контракта и KV-кеш, а не мгновенная (mid-turn) подхватка.
