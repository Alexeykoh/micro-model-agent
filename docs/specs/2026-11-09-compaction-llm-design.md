# Спека: режим компакции `llm` (`compactionSummary: off|ledger|llm`)

Дата: 2026-11-09. Ветка: `feat/compaction-llm`.
Источник задачи: `TODO.md §1.5`; план WS5 в
[`2026-10-06-harness-reliability-fixes.md`](../plans/2026-10-06-harness-reliability-fixes.md)
(Task 5.4/5.5 — отмечены [x], но не реализованы: в конфиге до сих пор `off|ledger`).

## Что неправильно

`buildCompactionBlock` несёт только task/plan/facts/errors и tool-ledger.
Факты из удалённых turns, не покрытые ledger (контекст, решения, «что уже
пробовали»), теряются — модель повторяет URL/чтения. LLM-сводки нет.

## Контракт

1. **Конфиг:** `contextBudget.compactionSummary` — `off|ledger|llm`
   (default `ledger`, без изменений). Значения пробрасываются в
   `ContextTuning`/`ContextState.compactionSummaryMode` как `"off" | "ledger" | "llm"`.
   i18n-описание (`config.desc.contextBudget.compactionSummary`, en+ru) обновляется.
   Web-настройки отдельной правки не требуют (ключ уже в списке секции контекста,
   значения — из registry).
2. **Helper (новый)** `src/core/context/compaction-llm-summary.ts`:
   - `buildOldTurnsText(oldTurns)` — плоский текст старых turns (роль + текст,
     кап ~8000 символов, tool-результаты урезаны до первой значимой строки).
   - `summarizeOldTurns(provider, oldTurns, cacheDir, sessionId?)` →
     `Promise<string | null>`: bounded-промпт «верни bullets max ~256 токенов,
     output ONLY bullets», `chat(..., { maxTokens: 512, reasoningEffort: "none", sessionId })`
     (2x запас как в `prompt-overflow-resolve.collectText`), AbortSignal с таймаутом
     8000мс. Кэш `<project>/.mma/cache/compaction-summaries/<sha256>.md` (best-effort).
     Любая ошибка/пустой ответ → `null` (fail-open).
   - Taint: сводка производна от oldTurns — помечает наследует обычный summary
     (`manager-compaction.ts`: taint oldTurns → taint summary). Отдельной маркировки
     не требуется.
3. **Проводка (без изменения сигнатур публичного API менеджера):**
   - `CompactOptions.llmSummary?: string` — готовый текст LLM-сводки.
   - `buildCompactionBlock` добавляет `[LLM summary]\n…` при `mode === "llm"` и
     непустом `llmSummary` (в `ledger`/`off` игнорируется).
   - `ContextManager.getOldTurnsText(keepLastN?)` — текст oldTurns для суммаризации
     (та же граница `computeCutoff`, что и в `compact()`).
4. **Асинхронная проводка (волна 1b):**
   - `CompactionService` принимает опциональный `llmSummarizer?: (text) => Promise<string|null>`
     и `cacheDir`/`sessionId`-провайдер; `compactIfNeeded`/`compactAfterTool` становятся
     **`async`** и при `mode === "llm"` сначала зовут суммаризатор, потом `compact({ llmSummary })`.
     При ошибке — ledger-only, ход не падает.
   - `runIterationPrologue` и вызов `compactAfterTool` в `tool-batch-calls` делают `await`;
     `loop-setup` собирает суммаризатор из `deps.llmProvider` + `config` + `baseDir`.
     При `mode !== "llm"` поведение синхрон-совместимо (тот же результат, лишний await — no-op).
   - Тесты сервиса (`compaction-policy`, `compaction-cooldown-invariant`,
     `compaction-no-reduction`) обновляются под `await` без смены ожиданий.

## Риски / почему default `ledger`

LLM добавляет до 8с латентности на компакцию и стоимость вызова;
поэтому `llm` — opt-in. Reduce-гарантия v2 (`computeMinReduction`) не меняется:
LLM-текст входит в `compactedBlock`, а не в историю напрямую.

## Приёмка

- `bun test tests/context-manager-ledger.test.ts tests/compaction-policy.test.ts tests/compaction-llm-summary.test.ts` зелёный;
  новый тест падает без правки (llmSummary попадает в блок только в режиме `llm`,
  fail-open на ошибке провайдера, кэш по hash).
- `bun run typecheck` + `bun run quality` (или как минимум затронутые гейты) зелёные.
- TODO `§1.5` закрывается только после живого прогона (отдельный пункт).
