# Аудит логики агента MMA — 2026-08-29

> Фокус: обработка ошибок, передача задач модели, контекст, управление моделью.
> База: `master` @ `af12430` (version 0.57.1). Прочитаны: `core/agent.ts`, `core/agent-moe.ts`, `core/bootstrap.ts`,
> `llm/openai-compat.ts`, `llm/orchestrator.ts`, `modules/context/manager.ts`, `modules/context/chunk-query.ts`,
> `modules/hallucination/*`, `modules/reasoning/*`, `tools/executor.ts`, `tools/subagent.ts`,
> `modules/execution/{moe-executor,plan-tool,stuck-detector}.ts`, `config/config.ts`, `cli/main.ts`.
>
> Источники известных проблем: `TODO.md`, `docs/superpowers/plans/2026-08-26-model-control-fixes.md`
> (39 находок / 35 задач / волны 1–9), `docs/superpowers/plans/2026-08-26-moe-completion.md`.

---

## 1. Резюме

Управляющая логика агента в целом зрелая: контекстный менеджер, компакция, stuck-detector и
plan-tool документированы и покрыты регрессиями. Однако **значительная часть критических находок
из плана `model-control-fixes` до сих пор не реализована** (волны 1, 4, 5, 6, 7, 8, 9 — в коде остались
в исходном виде). Сверх этого найдены **новые критические дефекты**, не покрытые ни одним из планов.

Ключевые темы:
1. **Передача задач модели** ломается в MoE-пути: `shared_context.rules` оркестратора никуда не
   попадает, параметры `subagent.shared_context` / `expert_tag` / `max_tokens` объявлены, но не читаются.
2. **Обработка ошибок**: rate-limiter кидает `throw` вместо ожидания; LLM-judge на слабой модели
   добавляет до 15s латентности ради косметического «warn»; оркестратор (MoE) вообще не прерывается по Esc.
3. **Контекст**: аргументы тулов не обрезаются в `<system-summary>` (дублирование больших `write_file`);
   системный промпт мутирует каждый ход (убивает prefix KV-cache); три несовместимых токен-эвристики.
4. **Логика цикла**: успех на последней итерации репортится как `success:false` (max_iters).

---

## 2. Подтверждённые «найдено, но НЕ устранено» (из TODO.md / model-control-fixes)

Проверено по текущему коду. Статус каждой находки из плана `2026-08-26-model-control-fixes.md`:

| # | Находка (оценка) | Статус в коде | Файл:строка |
|---|---|---|---|
| 1 / 13 | Аргументы тулов не обрезаются в `<system-summary>`; результат в контексте дважды | **НЕ устранено** | `agent.ts:999` (`JSON.stringify(call.arguments)` без лимита), дубль в `role:"tool"` (`agent.ts:977`) + envelope (`agent.ts:1074`) |
| 2 | Reasoning-полиси: `consecutiveSuccesses`/`isRepetitive` захардкожены | **Частично**: lifecycle флагов починен (`agent.ts:662-666`), но сигналы захардкожены `0`/`false` (`agent.ts:651-652`) | `agent.ts:645-654` |
| 4 | Компакция рвёт пары assistant(tool_calls)/tool | **Исправлено** | `manager.ts:406-415` |
| 3 | `set_thinking` не влияет на запросы | **Исправлено** | `agent.ts:634-660` |
| 5 | Non-streaming fallback игнорирует reasoning | **Исправлено** | `openai-compat.ts:132-143` |
| 6 | Rate limiter кидает plain Error до fetch | **НЕ устранено** | `openai-compat.ts:113-117` |
| 7 | Repetition overlap > 0.5 ретраит короткие ответы | **НЕ устранено** | `confidence.ts:37` |
| 8 | Успех на последней итерации → `success:false` max_iters | **НЕ устранено** | `agent.ts:1293` (проверка после цикла) |
| 9 / 11 | Два счётчика empty-response; `emptyResponseRetries` мёртв | **НЕ устранено** | `agent.ts:1233-1248` недостижим, т.к. `confidence.validate("")` → `retry` |
| 10 | LLM-judge на слабой модели + regex keyword decisions | **НЕ устранено** | `detector.ts:26,55`; `agent.ts:1216-1226` |
| 11 | Системный промпт мутирует каждый ход (KV-cache) | **НЕ устранено** | `agent.ts:277-283,597` |
| 12 | FactualCheck cooldown-ветка без тёплого кэша | **Частично**: кэш проверяется до cooldown (`factual.ts:127`), но rescan-логика сохранена | `factual.ts:139` |
| 14 | Три токен-эвристики (/2, /4, tiktoken) | **НЕ устранено** | `agent.ts:52,297`; `manager.ts:363` |
| 15 | Provenance по `provider.type`, не label | **НЕ устранено** | `agent.ts:136-141` |
| R2-1 | Таймер таймаута тула не очищается | **Исправлено** (timer + onAbort чистятся) | `executor.ts:101-148` |
| R2-2 | MoE теряет `onTool` | **НЕ устранено**: `opts.onTool` не деструктурируется | `agent-moe.ts:73` |
| R2-3 | Ответ MoE не пишется в context/session | **НЕ устранено**: MoE-ветка возвращает результат без `addMessage` | `agent.ts:416-434` |
| R2-4 | Утечка abort-listeners | **Исправлено** | `executor.ts:136` |
| R2-5 | chunk_query: один failed chunk убивает всё, нет AbortSignal | **НЕ устранено** | `chunk-query.ts:119-134` |
| M2 | `--json` без try/catch | **НЕ устранено** | `main.ts:68-93` |
| M4 | Wizard проверяет `homedir()/.mma`, игнорируя `MMA_CONFIG_DIR` | **НЕ устранено** | `main.ts:128-136` |
| B1 | Тулы читают протухший `toolCtx.config` | **НЕ устранено** | `bootstrap.ts:370` |
| B3 | len/4 занижает кириллицу ~×2 | **НЕ устранено** | `bootstrap.ts:326,569,608` |
| C1 | `MMA_PROVIDER_*` env игнорируются при `entries[]` | **НЕ устранено** | `config.ts:139-167` |
| C2 | Миграция удаляет живой конфиг | **НЕ устранено** | `config.ts:203-215` |
| C3 | `toConfig()` затирает `fallback` | **НЕ устранено** | `manager.ts` |
| C4 | Env-значения персистятся | **НЕ устранено** | `config.ts:139-167` |
| C5 | Битый config.json глотается молча | **НЕ устранено** | `config.ts:125-137` |
| C6 | deepMerge разрушает RegExp | **НЕ устранено** | `config.ts:48-67` |

Итого: из 35 задач плана в коде реализованы только **Task 2, 4, 5, 15, 18** (5 штук).
Остальные ~30 задач (включая все критичные Wave 1 #1/#13, Wave 4 #8/#11, Wave 7 #16/#17/#19,
Wave 8/9) **остаются открытыми**.

---

## 3. Новые критические находки (не покрыты ни одним планом)

### 🔴 N-1. MoE-оркестратор не прерывается по Esc — `chat()` без AbortSignal

**Где:** `src/llm/orchestrator.ts:110-120`, `src/core/agent-moe.ts:74-99`.

`OrchestratorClient.chat()` вызывает `this.provider.chat(messages)` **без сигнала**. `runWithMoE`
проверяет `signal.aborted` только *между* фазами (`ensureNotAborted()`), а `plan()`, `verifyAndMerge()`
и `resolveScopeRequest()` (а также `StepVerifier`) — не прерываемые LLM-вызовы, которые на слабой
модели могут идти минуты.

**Воздействие:** Esc/Ctrl+C во время MoE-планирования/верификации «зависает» до завершения
текущего вызова оркестратора. Контракт `AbortError` (код специально его кидает и ловит,
`agent-moe.ts:199-201`) фактически не работает на самом тяжёлом этапе.

**Фикс:** пробросить `signal` в `OrchestratorClient.plan/verifyAndMerge/resolveScopeRequest` →
`provider.chat(messages, tools, signal)`; в `runWithMoE` передать `signal` при конструировании клиента.

---

### 🔴 N-2. Лимит рекурсии субагента никогда не срабатывает

**Где:** `src/tools/subagent.ts:100,190`, `src/core/bootstrap.ts:376`, `src/tools/executor.ts` (shared ctx).

`subagent.handler` читает `ctx.recursionDepth` (строка 100) из **общего** `ToolContext` (тот же
`this.ctx`, что у родителя — субагент переиспользует `ctx.toolExecutor`). Инкремент
`subDeps.recursionDepth = currentDepth + 1` (строка 190) передаётся в `Agent`, но `AgentDeps` не
содержит поля `recursionDepth`, и `Agent` его не читает и никуда не пробрасывает. Родительский
`toolCtx.recursionDepth` навсегда остаётся `0`.

**Воздействие:** защита `maxRecursionDepth` (по умолчанию 3) мёртвая — субагент может порождать
субагентов произвольно (до `maxToolIterations` на каждом уровне), рекурсивно растёт стек вызовов и
стоимость. Это и логический, и ресурсный дефект.

**Фикс:** субагент должен получать собственный `ToolContext` с `recursionDepth = parent + 1` (или
исполнитель должен временно мутировать глубину на время вложенного `run`), а не читать глубину из
родительского ctx.

---

### 🔴 N-3. `shared_context` оркестратора и параметры `subagent` — мёртвые

**Где:** `src/tools/subagent.ts:59-62,45-48,63-66`, `src/modules/execution/moe-executor.ts:151-158`,
`src/llm/orchestrator.ts:52-55`.

Схема `subagent` объявляет `shared_context`, `expert_tag`, `max_tokens` — **ни один не читается
в handler** (читается только `args.context`). MoE-исполнитель строит `taskPrompt` из
`description/expected_output/success_criteria/scope/input_from`, но **не подмешивает
`plan.shared_context.rules` / `plan.shared_context.refs`**, которые оркестратор генерирует в
`PLAN_SYSTEM_PROMPT`.

**Воздействие:** общие правила/ограничения, которые оркестратор закладывает в план, молча
отбрасываются; субагенты исполняют без контекстных правил. Это прямая потеря данных при передаче
задачи модели в MoE-режиме.

**Фикс:** в `executeSubtask` добавить `shared_context.rules` в `taskPrompt`; в `subagent.handler`
использовать `args.shared_context` (или удалить мёртвые параметры из схемы и закрыть их валидацией).

---

### 🟠 N-4. LLM-judge блокирует критический путь до 15s ради «warn»

**Где:** `src/modules/hallucination/detector.ts:26,55`, `src/modules/hallucination/llm-judge.ts:32-76`,
`src/core/agent.ts:1113`.

`HallucinationDetector` создаёт `LLMJudge` **безусловно** (при наличии любого `llmProvider`, т.е.
всегда в бутстрапе). `detector.validate()` (await на каждый финальный ответ) дёргает
`judge.validate()`, у которого `JUDGE_TIMEOUT_MS = 15000`. При этом вердикт судьи может дать
**только** `warn` — он никогда не приводит к `retry`/`block` (`detector.ts:58`).

**Воздействие:** каждый финальный ответ (после того как regex-детектор решений что-то насобирал)
может добавлять до 15s задержки на **слабой модели** ради косметической пометки. Усугубляется
тем, что решение отслеживается regex-ом `plan|decided|решено` — срабатывает часто.

**Фикс:** (пересекается с Task 10) — гейтить судью за конфиг `hallucination.judge.enabled=false`
по умолчанию; запускать на orchestrator-провайдере, не на worker; либо не await на критическом пути
(асинхронная проверка после ответа). Убрать regex-извлечение решений (правило #10 AGENTS.md).

---

### 🟠 N-5. `LLMJudge.askJudge` — фоновый chat утекает после таймаута

**Где:** `src/modules/hallucination/llm-judge.ts:78-100`.

`Promise.race([consume, timeout])`: при срабатывании 15s таймаута `consume` продолжает стримить в
фоне. Если `provider.chat` затем упадёт — это **unhandled rejection** (ни у `consume`, ни у
результата `race` нет обработчика). Фоновый запрос также держит rate-limiter и сокет.

**Воздействие:** класс «отложенных побочных эффектов» (как R2-1/R2-4): фоновый вызов переживает
свой таймаут и портит чужое состояние / роняет процесс на unhandled rejection.

**Фикс:** сделать `consume` отменяемым (`AbortController`) и/или повесить `.catch(() => {})` на
`consume` до `Promise.race`; прерывать `provider.chat` при таймауте.

---

### 🟠 N-6. `resolveUsageTokens` смешивает кумулятивный completion с точечным prompt

**Где:** `src/core/agent.ts:257-275,779,1286-1291`.

При отсутствии `usage` в ответе (llama.cpp) `apiPromptTokens/apiCompletionTokens` = 0 → оценка:
`prompt = tokensUsed` (текущий размер контекста, точечное значение), а
`completion = apiCompletionChars / 4`, где `apiCompletionChars` **накапливается через все итерации**
(`agent.ts:779`). Масштабы несогласованы: `promptTokens` в JSON-результате — «сейчас», а
`completionTokens`/`totalTokens` — «всё за сессию».

**Воздействие:** ложные метрики токенов/стоимости в `--json` и `session.jsonl` для бэкендов без
`usage`. Не критично для выполнения, но ломает cost-атрибуцию и наблюдения.

**Фикс:** вести кумулятивный `estimatedPromptTokens` параллельно (или считать completion точечно
за последний вызов), чтобы обе части были в одном масштабе.

---

### 🟠 N-7. Бросок из `toolExecutor.execute` убивает всю сессию

**Где:** `src/core/agent.ts:914-922`.

`try { result = await toolExecutor.execute(...) } catch { synthesize...; throw err; }`. Хотя
`ToolExecutor.execute` ловит ошибки хендлера внутри, внешний `throw` (например, из `onBeforeTool`,
`killByCallId`, `onAfterTool` вне их try/catch, либо из любого плагина, бросившего наружу) пробрасывается
наверх из `executeSingleAgentLoop` → `run()` → `main()`. В `--json` это голый стек вместо
`{"success":false}` (усугубляет M2); сессия обрывается целиком.

**Воздействие:** один «бросивший» тул/плагин = потеря всей сессии вместо локального failed-результата.

**Фикс:** ловить бросок в `agent.ts` и конвертировать в `{ success:false, output }` (или хотя бы
возвращать `AgentResult` с `success:false`), а не пробрасывать.

---

### 🟠 N-8. Не-JSON single-run ветка тоже без try/catch

**Где:** `src/cli/main.ts:100-126`.

M2 фиксирует только `--json`-ветку. Но обычный single-run (`renderer`-ветка) тоже вызывает
`agent.run(prompt)` без `try/catch`: при `AbortError`/броске тула/плагина `agent.shutdown()` и
`updater.waitForIdle()` пропускаются, ошибка уходит в `main().catch` голым стеком.

**Фикс:** обернуть обе ветки (как в Task 22), гарантируя `shutdown()` + `waitForIdle()` в `finally`.

---

### 🟡 N-9. `ctx.cleanup` всё ещё читается в момент fire — nested-клоббер

**Где:** `src/tools/executor.ts:88-100`, `src/tools/subagent.ts:166`.

Task 15 (R2-1) убрал «старый таймер», но `failFast` по-прежнему читает `this.ctx.cleanup` **в момент
срабатывания**, а не захватывает локально на вызов. Вложенный сценарий: `subagent` ставит
`ctx.cleanup = () => setScope(parentScope)` (строка 166), затем внутренние тулы субагента выполняются
через тот же executor. Если внутренний тул таймаутит, `failFast` вызывает `ctx.cleanup()` — то есть
**сброс scope субагента посреди его работы**, а затем `ctx.cleanup = undefined`.

**Воздействие:** нарушение изоляции scope при таймауте вложенного тула (узкий, но реальный).

**Фикс:** захватывать cleanup локально на вызов (`const callCleanup = this.ctx.cleanup` до старта
handler) и/или не использовать общий `ctx.cleanup` для субагентов, а передавать cleanup в
`failFast` замыканием.

---

### 🟡 N-10. `chunk_query` синтез-промпт растёт без cap (дополнение к R2-5)

**Где:** `src/modules/context/chunk-query.ts:136-154`.

Помимо отсутствия per-chunk `catch` и `AbortSignal` (R2-5), `joined` (все ответы чанков) передаётся
в синтез-вызов целиком без ограничения длины. Для длинного текста (много чанков) синтез-промпт
может превысить контекст модели.

**Фикс:** обрезать `joined` (join до N символов + маркер), как и планировалось в Task 19.

---

## 4. Приоритеты исправлений

1. **N-2** (рекурсия субагента) + **N-1** (MoE не прерывается) — ресурс/безопасность.
2. **N-3** + **R2-2/R2-3** (потеря задач/ответов в MoE-пути) — целостность данных.
3. **#1/#13** (аргументы тулов + дубль контекста) — самый дешёвый и массовый выигрыш контекста.
4. **#8** (успех = max_iters) — ложный `success:false` на границе.
5. **N-4/N-5** (LLM-judge) — латентность и unhandled rejection.
6. **#6/#7/#9/#11**, **N-6/N-7/N-8/N-9/N-10**, Wave 8/9 — далее.

Рекомендуемый порядок совпадает с TODO.md: Wave 1 (контекст) → Wave 7 Tasks 16/17/19 (MoE) →
Wave 4 (#8/#11) → Wave 3 (#6/#7) → Wave 8/9 (init/config).

---

## 5. Сильные стороны (не трогать без нужды)

- Компакция с выравниванием по границам пар tool-call и переносом задачи/плана/«tried & failed» — сделано аккуратно.
- StuckDetector: классификация ошибок, anti-spam по warning-ключам, read-only loop, bash-flailing — зрелая.
- `plan`/`todo`: идемпотентность, order-enforcement, deliverable-gate, typecheck-gate, auto-archive.
- Executor: таймер/abort-слушатель теперь чистятся в `finally`.
