# Журнал прогона субагента в `session.jsonl` (design)

**Дата:** 2026-10-27 · **Ветка:** `feat/subagent-run-journal` · **Статус:** принято

## Проблема

Прогон субагента не оставляет в `session.jsonl` **ничего**: между `subagent`
call и result в `ses_mvoac9q9` 283 секунды и ноль событий. Стоимость прогона,
число LLM-вызовов, прочитанные файлы и причина падения восстановить нельзя;
«думал 4 минуты» и «прочитал 12 файлов» неотличимы. События прогона живут только
в памяти (`SubagentRunSink` веб-UI) и на SSE. Долг
`subagent-run-invisible-in-session-log` этим закрывается (оплачен 2026-10-27).

## Решение

Прогон становится **журналируемым подпотоком** той же сессии: один новый тип
записи `subagent` с полем `subagent: <runId>` и фазой.

Почему не «дать субагенту `SessionLogger` родителя»: `runTurn` пишет
`user`/`assistant` сообщения, двигает `meta`, делает автонейминг и старт сессии —
для подпотока это ложные события (задача субагента попала бы в историю как
сообщение пользователя). Поэтому подпоток пишет **только диагностику**: старт,
тулы, usage, конец. Историю хода пишет родитель.

### Контракт (`src/modules/session/store.ts`)

```ts
// type: ... | "subagent"
subagent?: string; // runId прогона (одна сессия может вести несколько)
status?: "running" | "done" | "failed" | "interrupted";
```

Запись `subagent` — одна форма на четыре фазы (`content` = фаза):

| фаза | поля | зачем |
|---|---|---|
| `start` | `content: "start"`, `tool` = задача (120 симв.), `subagent`, `iteration` = 0, `args: { depth, agent?, model? }` | что делегировано и кому |
| `tool` | `tool`, `success`, `duration`, `content` = голова вывода (≤200) | что субагент делал |
| `usage` | `iteration`, `content: "usage"`, `args: { provider, model, promptTokens, completionTokens, totalTokens, origin, costUsd? }` | стоимость с `origin` |
| `end` | `status`, `duration`, `iteration` = число итераций, `content` = ошибка (≤300) | чем кончилось и почему |

Источник (`source`) — `core`: пишет ядро, `subagent` отделяет подпоток от
родительского хода. Полный вывод тулов не пишем: журнал должен оставаться
грепабельным, тела уже есть в контексте/спиллах.

### Путь события

```
Agent.run (субагент)
  ├─ tool callbacks ──┐
  ├─ onUsage ─────────┤
  └─ finish ──────────┴─> SubagentRunEvent ──> emitSubagentEvent
                                              ├─ ctx.subagentRuns  (веб-UI, SSE)
                                              └─ ctx.subagentLog   (session.jsonl)
```

- `src/tools/subagent-runs.ts`: в союз `SubagentRunEvent` добавляется
  `{ kind: "llm_usage", ... }` (его игнорирует веб-сток: `usage` там уже есть в
  `end`); `emitSubagentEvent` зовёт **оба** приёмника, каждый fail-open.
- `src/core/bootstrap/tool-context.ts` и `session-runner-scope.ts`: строят
  `subagentLog` рядом с существующим `sessionLog` — там же, где в области
  видимости есть `sessionManager`. Запись через `sessionManager.appendLog`.
- `src/tools/subagent-session-log.ts`: **чистое** отображение
  `SubagentRunEvent → SessionLogEntry | undefined` (обрезает задачу/вывод/ошибку).
  Чистая функция — чтобы контракт записи проверялся тестом без сессий на диске.
- `src/core/agent.ts` (`AgentDeps.onUsage?`) + `token-tracker.ts`: per-call usage
  субагента уходит в приёмник прогона, а не в журнал родителя
  (`logUsage` уже знает `origin` и стоимость).

### Что НЕ меняется

- `session.jsonl` родителя: его собственные события не трогаются (только новые
  записи `subagent`).
- Веб-UI: `end.usage` как был; `text`/`reasoning` не журналируются.
- Replay/`/resume`: записи `subagent` — диагностика, в историю не подмешиваются
  (`loadSessionLog` их отдаёт, `diagnose` игнорирует).

## Тесты

1. `tests/tools/subagent-session-log.test.ts` — отображение каждого вида события
   в запись: `start`/`tool`/`llm_usage`/`end`, обрезка задачи/вывода/ошибки,
   отсутствие записи для `text`/`reasoning`/`phase`.
2. `tests/tools/subagent-runs-events.test.ts` (расширение) — `llm_usage`
   доходит до `ctx.subagentLog` и до `ctx.subagentRuns`; сломанный приёмник не
   ломает прогон (fail-open).
3. `tests/tools/subagent.test.ts` (расширение) — прогон через `agentFactory`
   с фейковым агентом пишет `start`/`tool`/`end` в переданный `subagentLog`.

## Вне скоупа

- Контекст субагента (compaction, `ctx used/limit`) — спека
  `2026-10-26-subagent-context-observability-design` (SSE).
- Реконструкция истории субагента для `/resume` — не нужна: прогон не сессия.
