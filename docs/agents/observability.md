# Наблюдаемость: сигналы fail-open (INV-15)

> Нормативный источник: [architecture v2 §1.4](../specs/2026-10-12-architecture-v2-design.md)
> (INV-13/14/15). Этот документ — **инвентарь fail-open путей**: мест, где
> подсистема по контракту не блокирует ход после отказа. Каждый такой путь
> обязан оставить в `session.jsonl` отдельный сигнал, иначе «сломался» неотличим
> от «сказал ок» — именно это делало разбор боевых сессий ручным (аудит §5.8).

## Формат

Сигнал — запись `SessionLogEntry` с `type` из списка ниже и полями
`Diagnostic` (INV-14): `source`, `operation`, `errorKind`, `cause`
(обязательна при `errorKind !== "ok"`), `recoverable`. Пишется через
`SessionLogger.logDiagnosticEvent(type, diag)`; `content` = `cause`
(совместимо со старыми читателями Trace).

## Инвентарь

| Сигнал | Fail-open путь | Где | Статус |
|---|---|---|---|
| `critic_error` | Критик не дал вердикта (verify бросил или вернул `null`) — ход продолжается как `pass` | `src/core/agent/critic-gate.ts` (`logDegraded`) | ✅ реализовано |
| `tool_attempt` | Хендлер тула бросил исключение; результат деградирован в `success:false`, ход продолжается | `src/core/agent/tool-batch.ts` (`executeCall` catch) | ✅ реализовано |
| `verify_error` | Верификатор деградировал: `validateSyntax` не проверяет синтаксис (нет `tsc`/проверка неоднозначна); `runTypeCheck`/`runTests` пропущены (нет `tsconfig`/`tsc`/`package.json`/test-скрипта) | `src/modules/execution/verifier.ts` (`StepVerifier.onDegrade`) → `ExecutionModule.reportDegrade` | ✅ реализовано |
| `admission_degraded` | Admission результата тула упал (fs/ENOTDIR/path-jail): результат возвращается сырьём, ход продолжается | `src/tools/admission.ts` (`admitFromContext` catch) → `ToolExecutor.setDiagnosticSink` | ✅ реализовано |
| `context_degraded` | Серия компакций без роста durable-леджера (модель сжимает историю, ничего не узнавая): сигнал вырожденной петли, ход продолжается | `src/core/context/compaction-progress.ts` (`CompactionProgressTracker`) → `ContextManager.setProgressDiagnosticSink` → `context-factory.ts` (`contextDegradedSink`) | ✅ реализовано |

### Как подключён `verify_error`

`StepVerifier` получает колбэк `onDegrade(operation, reason)` при создании
(`ExecutionModule` передаёт `reportDegrade`). `ExecutionModule.setDiagnosticSink`
ставит `agent-phase`/`session-runner` (main и каждый раннер) — sink пишет
`verify_error` в свою сессию тем же путём, что `sessionLog.plan`
(`sessionManager.appendLog`). `ToolContext` при этом **не** расширялся: шов
«Agent/раннер → свой `ExecutionModule`» достаточен и не тянет контракт тулов.
Subagent не несёт `ExecutionModule`, поэтому его деградации идут в сессию
родителя через тот же main-модуль.

### Как подключён `context_degraded`

`ContextManager` держит `CompactionProgressTracker` (счётчик серии компакций без
роста durable-леджера). На каждой значимой компакции (`compact`/`compactAdaptive`
через `finalizeCompact`, а также `hard-drop`) трекер получает текущий `size()`
леджера; серия ≥2 без роста эмитит `no-progress`. Sink ставит фабрика
`createContextManager(config, baseDir, sessionManager)`: обе точки bootstrap
(`session-phase.ts` — main, `session-runner.ts` — запиненный sibling раннера)
передают свой `SessionManager`, поэтому запись `context_degraded` попадает в
сессию владельца хода.

## Каталог сигнатур (`mma session diagnose`)

Сигнатуры — не события лога, а **патологии**, вычисляемые по нему: разбор
боевой сессии иначе делается руками и не воспроизводится (спека
`2026-10-15-session-diagnose-design.md`). Каталог живёт здесь, а не в `debt.md`:
это сигнатуры, а не долги. Каждая придумана по реальному фиксу.

| kind | Что означает | Источник в `session.jsonl` | Порог |
|---|---|---|---|
| `compaction_stall` | серия компакций подряд (без прогресса леджера) | `compaction` в окне 2 мин + `context_degraded` | ≥ 3 |
| `prompt_block_dropped` | блок промпта не влез в бюджет | `context` → `blocks[].included === false` | любое число, группировка по подписи |
| `critic_degraded` | критика нет/деградировал, ход ушёл как `pass` | `critic_error` | ≥ 1 |
| `tool_failure_repeat` | один и тот же тул падает подряд | `tool_result` c `success:false` | ≥ 3 |
| `security_block_repeat` | модель упирается в одну и ту же стену | `tool_result` c `[SECURITY BLOCKED]`, группировка по паттерну | ≥ 2 |
| `claim_retry` | ход уходил в ретрай | `claim_retry` по классу `kind` | ≥ 2 |

Пороги живут именованными константами в `src/modules/session/diagnose.ts`
(`thresholds`), чтобы их правка не выглядела как «случайно поменялось поведение».
Проверка: `tests/core/session-diagnose.test.ts` на обезличенной фикстуре
`tests/fixtures/session-diagnose/session.jsonl` (реальная сессия
`ses_mv8h787b_wuu8g1`, давшая четыре фикса) — фикстура обязана дать ≥ 5 видов
сигнатур. Фикстура пересобирается `scripts/build-session-fixture.ts`.

## Что это не чинит

Сигнал сообщает о деградации, но не меняет поведение fail-open: критик по-прежнему
не блокирует агента, а упавший тул по-прежнему даёт failed-результат. INV-15 — про
**различимость**, а не про запрет деградации.

## Проверки

- `tests/critic-gate.test.ts` — `critic_error` пишется при отказе критика (throw и null).
- `tests/session-logger.test.ts` — `logDiagnosticEvent` персистит форму `Diagnostic`.
- `tests/core/compaction-progress.test.ts` — `context_degraded` при серии компакций без роста леджера.
- `tests/output/source-filled.test.ts` — источник события непуст (INV-13).
