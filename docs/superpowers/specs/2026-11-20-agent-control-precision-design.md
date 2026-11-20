# MMA — точность контроля агента (0.26.1, следующая волна)

**Дата:** 2026-11-20 · **Ветка:** `feat/control-precision` · **База:** `dev` после `feat/agent-quality-control`
**Источник:** живые прогоны `ses_mwp6ft2u_bnkrezboqgkwqvaq` на `bonsai-2-27b-pq2`
(llama.cpp / llama-swap), журнал `docs/development/2026-11-20-agent-quality-control-0.26.1.md`.

## 1. Проблема

AQC-1…8 устранили structural-дыры, но живой прогон показал четыре остаточные проблемы контроля:

1. Критик выдал ложное «note.txt не существует» при существующем файле — ретракция черновика и ~30 c впустую.
2. Модель получила корректный actionable-текст блокировки, но пересказала его неверно в финале.
3. На тривиальную задачу ушло 18 тулов / 139 c при `maxToolIterations=20`.
4. После компакции в сводку попал stale-вывод «plan_step disabled», который отравил два следующих хода; plan coverage реагировал на файлы прошлого запроса; правила памяти об ошибках не имели TTL.

## 2. Инварианты

| ID | Инвариант | Гейт |
|----|-----------|------|
| **BCP-1** | Утверждение критика «file missing» не доходит до модели, если файл существует в рабочей директории или в tool trail есть успешная операция с этим путём | `tests/core/critic-file-claim.test.ts` |
| **BCP-2** | Если за ход был blocked-результат тула, финальный ответ, говорящий об этом url/политике, обязан содержать каноничную фразу из `errorMeta`; иначе ровно один re-answer | `tests/core/blocked-claim-gate.test.ts` |
| **BCP-3** | После `SOFT_TOOL_BUDGET` тулов за ход цикл Structural переходит в tool-less финал с новым `stopReason: "soft_tool_budget"` | `tests/core/soft-tool-budget.test.ts`, `tests/replay/invariants.test.ts` |
| **BCP-4** | Сводка компакции не содержит error-ledger и claims старше текущего хода | `tests/core/compaction-summary-sanitize.test.ts` |
| **BCP-5** | `checkPlanCoverage` использует только текущее пользовательское сообщение | `tests/execution/plan-coverage-current-turn.test.ts` |
| **BCP-6** | Статический ход без behavioral-шагов не вызывает LLM-критика; решение пишется в `session.jsonl` | `tests/core/critic-static-fastpath.test.ts` |
| **BCP-7** | Правило памяти об ошибке имеет `turnId` и истекает через `ERROR_RULE_TTL_TURNS` или при успешном повторе тула | `tests/core/failure-memory-ttl.test.ts` |
| **BCP-8** | AQC-7 проверен вживую отдельным прогоном с мёртвым провайдером, без изменения кода | отчёт в журнале |

## 3. Контракты и потоки

### BCP-1 — проверка утверждений критика
Новый чистый хелпер `src/core/agent/critic-file-claim.ts`:
`filterFileClaims(issues: CriticIssue[], opts: { baseDir: string; toolEvents: ToolEvent[] }): CriticIssue[]`.
Вызывается в `critic-gate.ts` после `withProvenance`, до `injectRepair`/`injectAdvice`.
Отброшенные issue пишутся в `session.jsonl` как `critic_verdict { droppedFileClaims: N }` (INV-15).
Правило №10 архитектуры не нарушается: решение принимается по machine-readable путям и tool trail, а не по словам описания.

### BCP-2 — каноничная фраза блокировки
Заблокированный `ToolResult` уже несёт `errorMeta.code` и каноничный текст advice.
Новый гейт `src/core/agent/blocked-claim-gate.ts` перед `auditGate` в `loop-gates.ts`:
- если в tool trail есть `blocked: true` и ответ содержит url из blocked-результата,
  но не содержит каноничной фразы — вернуть `continue` с однократной инъекцией каноничного текста;
- счётчик `blockedClaimCycles` в `LoopState`, кап 1.

### BCP-3 — мягкий бюджет тулов
`SOFT_TOOL_BUDGET = 12` в `src/core/agent/constants.ts`.
`tool-batch-signals.ts` возвращает `{ finalize: "soft_tool_budget" }` при достижении порога,
если нет уже терминального `failed_batches`/`stalled`. `StopReason` расширяется.
`loop-final.ts` использует существующий tool-less путь, текст через i18n `finalize_soft_budget`.

### BCP-4 — санитизация сводки
`manager-compaction.ts` при формировании `<system-summary>` фильтрует ledger-записи по `turnId`
текущего хода; error-записи старше текущего хода заменяются на краткую pomетку «historical, resolved or superseded».

### BCP-5 — plan coverage
`plan-coverage.ts` получает `taskText` только из текущего `input` пользователя.
Вызов в `plan-actions.ts` меняется с `deps.getTaskText(ctx)` на явный текущий prompt.

### BCP-6 — дешёвый критик
`CriticGate.shouldRun()` перед LLM-вызовом: если все toolEvents относятся к `file/code`,
изменённые файлы существуют и diff непустой, и нет behavioral-шагов — вернуть `pass` с записью
`critic_verdict { skipped: "static_fastpath" }`. Иначе обычный путь.

### BCP-7 — TTL памяти
`FailureRule` получает `turnId`; `recordRepeatedToolFailure` удаляет правила с возрастом
>`ERROR_RULE_TTL_TURNS = 3` или при `result.success` для того же тула. Запись об удалении — в лог.

## 4. Что не делается

- Изменение дефолтов `security.network.*`, версии и `CHANGELOG.md`.
- Forced `tool_choice`, удаление контекста после провала, непарный `block`.
- Переписывание UI-ассетов: e2e уже починен под текущий UI.

## 5. Порядок волн

1. BCP-1 + BCP-6 + BCP-5 — точность и стоимость критика/плана.
2. BCP-2 + BCP-3 — структурированный ответ и бюджет тулов.
3. BCP-4 + BCP-7 — память и компакция.
4. BCP-8 — живая проверка AQC-7 в `mma web`.
