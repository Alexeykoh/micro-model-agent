# Спека: чекпоинтер хода (Durable state 2/4)

Дата: 2026-11-09. Ветка: `feat/durable-checkpointer` (2/4 durable-state:
thread_id закрыт, далее проверка retention/long-term store).
Источник: `TODO.md §3 P0 Durable state`,
[`2026-09-28-production-readiness`](../archive/specs/2026/2026-09-28-production-readiness-design.md) §4.

## Что неправильно

`history.jsonl` + `session.jsonl` переживают краш, но состояние цикла —
нет: счётчики итераций, streaks (duplicate/stall/research), кулдауны
компакции, `seenToolCalls`, `disabledTools`, `toolFailureCounts` и т.д.
 живут только в `LoopState` памяти. После `/resume` цикл стартует с
нулевыми счётчиками — регрессия поведения (повтор тех же тулов,
 потерянный honest-stop, «свежая» фаза stall).

## Контракт

1. **Файл:** `<sessionDir>/checkpoint.json` (`v: 1`, атомарная запись
   temp+rename, шифрование при включённой опции как у meta).
   Опциональный интерфейс `Checkpointer` (`save/load`), реализация — файл,
   Postgres-драйвер вне скоупа.
2. **Атомарность:** `saveTurnCheckpoint(id, snap)` выполняется синхронно
   на границе батча тулов (после `ToolCallRunner.finalize` в цикле) —
   краш между инструментом и записью означает «снимок предыдущего круга»,
   что эквивалентно потерянной итерации, а не битому состоянию.
3. **Содержимое** — только счётчики/флаги/множества (НЕ тексты ответов,
   НЕ history; история уже на диске):
   `iteration`, `pendingCompaction`, 4 compaction-clocks,
   `reactiveCompactionUsed`, streaks+флаги (duplicate/research/stall/
   silent/narration), `seenToolCalls`+`novelToolKeys` (кап 500 ключей),
   `disabledTools`, `toolFailureCounts` (кап 50 тулз),
   `memoryRuleRecorded`, `toolTargetCounts` (кап 100), `cycleNudgedKeys`,
   `consecutiveSingleQuestions`, `questionBatchNudged`,
   `sawSecurityBlock`, `scriptWorkaroundNudged`, retry-счётчики
   (`hallucination/claim/artifact/output/web/fileCreation/llmError/truncation`),
   `auditRetries`, `criticCalls`, `mutationsSinceCritic`, `criticHistoryMark`,
   `seenCriticIssues` (кап 100), `lastFinishReason`, `finalAnswerAccepted`.
   Токены/стоимости НЕ персистятся (они уже в `llm_usage` журнала).
   `seen tool keys` сохраняются — иначе duplicate-детектор после resume
   «не помнит» ход.
4. **Resume:** `loop-setup` после `createLoopState()` — `load` чекпоинта
   активной сессии → `restoreInto(state, snap)`; `null`/ошибка/битая
   верстка → пустое состояние (fail-open, диагностика в `app.jsonl`).
5. **Версионирование:** неизвестная `v` → `null` (fail-open).
   Несовместимый `threadId` снапшота (чужой поток) → игнорировать.

## Приёмка

- Тест: снапшот `loopState` → JSON → restore → ключевые поля равны
  (включая `seenToolCalls`/`disabledTools`/ falhas-счётчики).
- Тест на store: save/load round-trip, атомарность (не остаётся `.tmp`),
  битый JSON → `null`.
- `bun test tests/session/ tests/core/agent*.test.ts` зелёный (или новые гейты).

## Что НЕ покрывается (следующие ветки)

Retention-prune по `retentionDays` (3/4) и long-term store с TTL (4/4).
