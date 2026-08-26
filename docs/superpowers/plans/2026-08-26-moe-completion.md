# MoE Completion — из MVP в основной режим

> **Дата:** 2026-08-26
> **Спека:** `docs/specs/2025-07-30-agent-level-moe.md`
> **Цель:** завершить все пост-MVP пункты, закрыть дыры текущей реализации и сделать MoE
> надёжным настолько, чтобы он мог претендовать на роль основного режима агента.
>
> **Формат:** plans-are-prompts (GSD). Каждый план = 2-3 задачи, атомарные коммиты,
> `bun test` + `tsc --noEmit` перед каждым коммитом.

---

## 1. Аудит текущего состояния (что нашёл в коде)

### Что уже работает

| Механизм | Где | Состояние |
|---|---|---|
| Decision point в `run()` | `src/core/agent.ts:428` | ✅ `moe.enabled` → `runWithMoE`, fallback → single loop |
| Router plan / verifyAndMerge | `src/llm/orchestrator.ts` | ✅ jsonrepair, 3 re-plan cycles счётчик |
| Валидация плана | `src/modules/execution/plan-validator.ts` | ✅ циклы, write-write overlap, read-after-write autofix |
| Исполнитель | `src/modules/execution/moe-executor.ts` | ✅ topo-sort волны, semaphore (`maxParallelTasks`, default 5), retry transient, StuckDetector hints |
| Pass-by-reference артефакты | `moe-executor.ts:142-180` | ✅ `result_mode: "file"` → ArtifactStore |
| Глобальная верификация | `verifier.ts verifyMoEManifest` | ✅ tsc + файлы из allowed_files |
| Тесты | `tests/modules/execution/moe-executor*.test.ts`, `plan-validator.test.ts`, `tests/llm/orchestrator-modes.test.ts` | ✅ базовое покрытие |

### Критические дыры (блокеры для «основного режима»)

1. **Re-plan НЕ выполняется** — `agent-moe.ts:130-134`: если `verifyResult.type === "replan"`,
   план просто **печатается** («Re-plan requested: …») и результат возвращается как есть.
   `OrchestratorClient.replanCycle` инкрементится вхолостую. Главный механизм спеки — мёртвый код.
2. **`input_from` не реализован** — поле есть в типах (`types.ts:8`) и в промпте Router,
   но `MoEExecutor.executeSubtask` получает `_sharedContext` (unused!) и никогда не подставляет
   результаты зависимых сабтасков в промпт. Cross-expert result flow отсутствует — данные
   проходят только через файлы, о которых сабтаск должен «догадаться».
3. **Scope expansion не реализован** (post-MVP §1 спеки) — файл вне `allowed_files` = падение
   сабтаска + полный re-plan вместо точечного расширения.
4. **Эксперты захардкожены в Router** — `PLAN_SYSTEM_PROMPT` (orchestrator.ts:21-25) перечисляет
   `code/research/browser/vision` строками. Конфиг `experts` в промпт не попадает: добавил эксперт
   в конфиг — Router о нём не знает.
5. **Нет Abort/interrupt** — `runWithMoE` не принимает `AbortSignal`: Esc во время MoE-прогона
   не прерывает ни Router, ни волны сабтасков. Для основного режима это блокер.
6. **Сессия вслепую** — subtask'и исполняются с `sessionId: "moe"` (хардкод), ничего не пишется
   в `session.jsonl`/`history.jsonl`, нет provenance (provider/model) по сабтаскам, cost tracking
   не подключён. Пост-мортем MoE-прогона невозможен.
7. **Partial failure = полный провал** — упал один сабтаск из пяти → весь план `success: false`,
   хотя re-plan должен пересобрать только упавшие шаги (аналог `re-plan` в plan-store).
8. **Per-subtask верификация отсутствует** — `verifyMoEManifest` проверяет tsc + существование
   файлов, но `success_criteria` из сабтасков никем не проверяются до merge.
9. **Мелочи:** `knownTags` хардкод в agent-moe.ts:95; `ExpertConfig` без `description`/`max_tokens`;
   `moe.maxReplanCycles` захардкожен (3); OrchestratorClient строит provider напрямую, минуя
   ProviderManager (нет hot-swap/failover/priority).

---

## 2. Цель и must-haves (goal-backward)

**Цель (outcome):** пользователь включает `moe.enabled: true` и сложная многофайловая задача
проходит end-to-end надёжнее и быстрее, чем single-agent; при сбоях система сама чинится
точечным re-plan; каждый прогон полностью наблюдаем (сессия, стоимость, прерывание).

**Observable truths (что должно быть TRUE):**

1. Пользователь может прервать MoE-прогон двойным Esc — всё останавливается, orphan-процессов нет.
2. Если 1 из N сабтасков упал — система пере-plans ТОЛЬКО упавшие, успешные результаты сохраняются.
3. Сабтаск B, зависящий от A через `input_from`, получает реальный вывод A в своём промпте.
4. Subagent, которому не хватило файла, запрашивает scope у Router — Router approve/redirect/reject;
   автоматического расширения нет.
5. Новый эксперт, добавленный в `~/.mma/config.json` → `experts`, сразу доступен Router'у без правки кода.
6. После MoE-прогона в `session show <id>` видны: план, каждый сабтаск (статус, длительность, токены, стоимость), re-plan решения.
7. Certification-сценарий с тегом `moe` проходит на сертифицированной модели ≥ 2/3 reps.

---

## 3. Фазы и планы

### Wave structure

```
Wave 1: P1.1 (re-plan core)          P1.2 (input_from)         ← независимы
Wave 2: P2.1 (scope_request)         P4.1 (abort signal)       ← независимы
Wave 3: P3.1 (dynamic experts)       P3.2 (orchestrator via PM) P4.2 (session+cost)
Wave 4: P5.1 (per-subtask verify)    P5.2 (partial-failure policy)
Wave 5: P5.3 (certification + docs)
```

---

### PHASE 1 — Корректность ядра

#### Plan 1.1: Живой re-plan цикл

```yaml
phase: moe-completion
plan: 01-replan-core
type: execute
wave: 1
depends_on: []
files_modified:
  - src/core/agent-moe.ts
  - src/llm/orchestrator.ts
  - src/config/types.ts
  - src/config/defaults.ts
  - src/i18n/en.json
  - src/i18n/ru.json
  - tests/core/moe-replan.test.ts
must_haves:
  truths:
    - verifyResult type=replan запускает повторное выполнение нового плана (до moe.maxReplanCycles, default 3)
    - успешные результаты предыдущих циклов попадают в контекст verifyAndMerge следующего цикла
    - после исчерпания циклов возвращается partial result с честным success:false
```

<tasks>

<task type="auto">
<name>Task 1: extractToLoop runWithMoE</name>
<files>src/core/agent-moe.ts</files>
<action>Реорганизовать runWithMoE в цикл: `for cycle in 0..config.moe.maxReplanCycles`. На каждой итерации: (уже есть план?) → validatePlan → executor.executePlan → StepVerifier.verifyMoEManifest → orchestrator.verifyAndMerge. При `type === "replan"`: заменить plan на `verifyResult.plan`, прогнать через validatePlan+applyAutoFixes (не доверяем LLM), НЕ затирать накопленные `allResults` — мерджить по subtaskId (уникальные id новых сабтасков добавляются, совпадающие — заменяются). При `type === "final"` — выйти. Вынести текущее тело в приватную функцию executeCycle(), чтобы файл остался <300 строк (при превышении — вынести replan-логику в `src/modules/execution/replan-loop.ts`).</action>
<verify>bun test tests/core/moe-replan.test.ts</verify>
<done>Моковый orchestrator возвращает final→replan→final: второй план реально исполняется, результаты обоих циклов присутствуют в итоговом AgentResult.text, счётчик циклов уважается.</done>
</task>

<task type="auto">
<name>Task 2: config moe.maxReplanCycles + i18n</name>
<files>src/config/types.ts, src/config/defaults.ts, src/i18n/en.json, src/i18n/ru.json</files>
<action>`MoeConfig { enabled: boolean; maxReplanCycles?: number }` — default 3 в defaults.ts. Убрать магическую константу 3 из orchestrator.verifyAndMerge (цикл считает вызывающий). Все пользовательские сообщения цикла (replan started N/M, cycles exhausted) — через t() en+ru.</action>
<verify>bun test tests/config.test.ts && bunx tsc --noEmit</verify>
<done>Конфиг опционален, обратная совместимость (старые config.json без поля работают), оба i18n файла синхронны.</done>
</task>

</tasks>

#### Plan 1.2: input_from — cross-expert data flow

```yaml
plan: 02-input-from
type: execute
wave: 1
depends_on: []
files_modified:
  - src/modules/execution/moe-executor.ts
  - src/modules/execution/types.ts
  - tests/modules/execution/moe-input-from.test.ts
must_haves:
  truths:
    - subtask с input_from: [{subtaskId: A, field: "..."}] получает содержимое результата A в своём taskPrompt
```

<tasks>

<task type="auto">
<name>Task 1: подстановка результатов зависимых сабтасков</name>
<files>src/modules/execution/moe-executor.ts</files>
<action>executeSubtask принимает третий параметр `depResults: Map<string, SubtaskResult>` (заменить unused `_sharedContext`). В executePlan перед выполнением волны собрать Map из results. В taskPrompt добавить секцию `\n\nInput from previous tasks:\n` c обрезанным (cap `subagent.maxSummaryChars`, default из конфига) содержимым `result` каждого dep; если dep failed — явно написать `[task-X FAILED: error]`, чтобы читающий сабтаск не строил логику на пустоте. При resultMode=file — читать полный artifact через ArtifactStore (уже есть метод).</action>
<verify>bun test tests/modules/execution/moe-input-from.test.ts</verify>
<done>Тест: subtask B с input_from=[A] получает текст ответа A в промпте (мок subagent handler захватывает args.task); failed dep → маркер FAILED в промпте.</done>
</task>

<task type="auto">
<name>Task 2: validator для input_from</name>
<files>src/modules/execution/plan-validator.ts</files>
<action>Новая проверка expertTagsExist-стиля: каждая запись input_from ссылается на существующий subtaskId и этот id присутствует в depends_on (иначе гонка). Отсутствие depends_on → autoFix (добавить). Битый subtaskId → error.</action>
<verify>bun test tests/modules/execution/plan-validator.test.ts</verify>
<done>3 новых кейса: битый ref = error; ref без depends_on = autofix; корректный ref = чисто.</done>
</task>

</tasks>

---

### PHASE 2 — Scope expansion (post-MVP §1 спеки)

#### Plan 2.1: протокол scope_request

```yaml
plan: 03-scope-request
type: execute
wave: 2
depends_on: ["01-replan-core"]
files_modified:
  - src/tools/subagent.ts
  - src/modules/execution/moe-executor.ts
  - src/modules/execution/types.ts
  - src/llm/orchestrator.ts
  - tests/moe-scope-request.test.ts
must_haves:
  truths:
    - subagent при отказе path-guard возвращает структурированный scope_request, а не голую ошибку
    - Router решает approve/redirect/reject; авто-расширения нет
```

<tasks>

<task type="auto">
<name>Task 1: structured scope denial в subagent</name>
<files>src/tools/subagent.ts</files>
<action>Когда isPathInScope/isPathWritable блокирует операцию дочернего агента — child собирает запрос: вместо простого `success:false` output заканчивается машиночитаемым блоком `<scope-request>{"files":[...],"reason":"...","read_only":true|false}</scope-request>` (файлы накапливаются за ход child'а; prompt child'а инструктируется: при отказе доступа — продолжить то, что можно, и перечислить недостающие файлы в финальном ответе в этом формате). Executor MoE парсит блок regex'ом; нет блока → обычный fail.</action>
<verify>bun test tests/moe-scope-request.test.ts</verify>
<done>Мок-child, вернувший scope-request, распознаётся executor'ом как `{kind:"scope_request", files, reason}`.</done>
</task>

<task type="auto">
<name>Task 2: Router decision + переисполнение</name>
<files>src/modules/execution/moe-executor.ts, src/llm/orchestrator.ts, src/modules/execution/types.ts</files>
<action>New orchestrator method `resolveScopeRequest(req, subtask): {action:"approve", files, read_only} | {action:"reject"} ` (JSON, jsonrepair — тот же parseJSON). Approve → дозаполнить subtask.allowed_files/read_only_files и переисполнить ТОЛЬКО этот subtask (переиспользование executeSubtask, max_attempts заново). Reject → сабтаск failed, дальше штатно попадает в re-plan. Лимит: ≤2 scope-цикла на сабтаск, иначе reject (защита от петли). Решения логируются logger.info + i18n meta.</action>
<verify>bun test tests/moe-scope-request.test.ts && bunx tsc --noEmit</verify>
<done>Approve расширяет scope и сабтаск успешно переисполняется; reject помечает fail; 3-й запрос авто-reject.</done>
</task>

</tasks>

---

### PHASE 3 — Качество Router

#### Plan 3.1: динамические эксперты в Router

```yaml
plan: 04-dynamic-experts
type: execute
wave: 3
depends_on: []
files_modified:
  - src/llm/orchestrator.ts
  - src/config/types.ts
  - src/config/defaults.ts
  - tests/llm/orchestrator-modes.test.ts
must_haves:
  truths:
    - experts из config.experts попадают в PLAN_SYSTEM_PROMPT (тег, описание, tool_tags)
    - добавление эксперта в конфиг меняет поведение Router без правки кода
```

<tasks>

<task type="auto">
<name>Task 1: ExpertConfig.description + генерация списка</name>
<files>src/config/types.ts, src/config/defaults.ts, src/llm/orchestrator.ts</files>
<action>`ExpertConfig { model, tool_tags, max_attempts?, description? }`. OrchestratorClient.plan() принимает вторым параметром список экспертов `{tag, description, tool_tags}[]` (агент-moe достаёт из config.experts; description fallback = `"tools: ${tool_tags.join(", ")}"`). PLAN_SYSTEM_PROMPT превращается в шаблон: список экспертов рендерится в system prompt вместо хардкода code/research/browser/vision. Правило «expert_tag только из списка» усилить примером-противофазой.</action>
<verify>bun test tests/llm/orchestrator-modes.test.ts</verify>
<done>Тест: кастомный эксперт `rust-dev` из конфига появляется в отправленном system prompt (перехват provider.chat), хардкод-список исчез.</done>
</task>

<task type="auto">
<name>Task 2: knownTags из реестра</name>
<files>src/core/agent-moe.ts</files>
<action>Убрать хардкод `knownTags = ["file","code",...]` (строка 95): collectKnownToolTags() из ToolRegistry (все tags всех tools ∪ alwaysOn). Передавать и в verifyMoEManifest, и в orchestrator.plan.</action>
<verify>grep -rn '"vision"' src/core/agent-moe.ts → пусто; bun test tests/core</verify>
<done>Единый источник тегов — реестр инструментов.</done>
</task>

</tasks>

#### Plan 3.2: Orchestrator через ProviderManager

```yaml
plan: 05-orchestrator-pm
type: execute
wave: 3
depends_on: []
files_modified:
  - src/llm/orchestrator.ts
  - src/core/agent-moe.ts
  - tests/llm/orchestrator-modes.test.ts
```

<tasks>

<task type="auto">
<name>Task 1: единый путь построения provider</name>
<files>src/llm/orchestrator.ts, src/core/agent-moe.ts</files>
<action>Сейчас OrchestratorClient сам зовёт createProvider с захардкоженным contextWindow 32768 и без rateLimits/retry из entry. Провайдер оркестратора строить через ProviderManager (как основной): если orchestrator.provider указывает имя entry — взять manager.build(name); contextWindow/maxCompletionTokens/rateLimits из entry; failover работает. Обратная совместимость: legacy {type,baseUrl,apiKey} продолжает работать через createProvider. MoEDeps получает providerManager (опционально).</action>
<verify>bunx tsc --noEmit && bun test tests/llm</verify>
<done>Оркестратор наследует retry/failover/contextWindow своей entry; legacy-конфиг не сломан (тесты обоих путей).</done>
</task>

</tasks>

---

### PHASE 4 — Интеграция с harness

#### Plan 4.1: Abort/interrupt

```yaml
plan: 06-abort
type: execute
wave: 2
depends_on: []
files_modified:
  - src/core/agent-moe.ts
  - src/core/agent.ts
  - src/modules/execution/moe-executor.ts
  - tests/core/moe-abort.test.ts
must_haves:
  truths:
    - двойное Esc во время MoE прерывает Router/волны; Agent.shutdown() убивает фоновые процессы сабтасков
```

<tasks>

<task type="auto">
<name>Task 1: signal threading</name>
<files>src/core/agent-moe.ts, src/core/agent.ts, src/modules/execution/moe-executor.ts</files>
<action>Agent.run() прокидывает this.deps.signal (AbortController из shutdown()) в MoEDeps. runWithMoE: перед каждым LLM-вызовом Router и каждой волной — check signal.aborted → бросить AbortError. MoEExecutor.executeSubtask: передавать ctx.signal в subagent handler (subagent уже умеет abort через LLM chat signal — проверить цепочку), между retry-attempts ждать abort. finally-гарантии: незавершённые wave-promises получают результат aborted, никаких висящих acquire().</action>
<verify>bun test tests/core/moe-abort.test.ts</verify>
<done>Тест: abort посреди первой волны — run() бросает AbortError, второй сабтаск не стартовал, fallback НЕ вызывается (interrupt ≠ ошибка MoE).</done>
</task>

</tasks>

#### Plan 4.2: Наблюдаемость — сессия, provenance, cost

```yaml
plan: 07-observability
type: execute
wave: 3
depends_on: []
files_modified:
  - src/core/session-logger.ts
  - src/core/agent-moe.ts
  - src/modules/pricing/index.ts
  - tests/session-moe-log.test.ts
must_haves:
  truths:
    - session.jsonl содержит события moe_plan / moe_subtask / moe_replan / moe_verify с tokens+cost
    - session show отображает MoE-прогон человекочитаемо
```

<tasks>

<task type="auto">
<name>Task 1: типы событий MoE в SessionLogger</name>
<files>src/core/session-logger.ts, src/core/agent-moe.ts</files>
<action>SessionLogEntry += `moe_plan` (title, subtasks[], cycle), `moe_subtask` (id, expert_tag, status, durationMs, promptTokens/completionTokens/costUsd/source), `moe_replan` (cycle, reason, kept/new ids), `moе_verify` (passed, errors). runWithMoE пишет их через slog (прокинуть SessionLogger в MoEDeps). sessionId пробросить реальный вместо хардкода "moe" (из deps.sessionContext), ArtifactStore тоже.</action>
<verify>bun test tests/session-moe-log.test.ts</verify>
<done>Прогон с моками пишет все 4 типа событий в порядке выполнения; `mma session show` печатает сводку MoE.</done>
</task>

<task type="auto">
<name>Task 2: cost attribution per subtask</name>
<files>src/modules/pricing/index.ts, src/core/agent-moe.ts</files>
<action>CostTracker.record уже умеет per-provider; добавить измерение per-call внутри subtask-цикла (subagent возвращает usage? если нет — считать через TokenCounter estimate, source:"estimate"). Итог: AgentResult.totalCost + breakdown по expert_tag в AgentResult.costBreakdown (переиспользовать формат repl.cost_breakdown).</action>
<verify>bun test tests/pricing.test.ts</verify>
<done>После MoE-прогона --json показывает totalCost и breakdown {expert_tag: $}.</done>
</task>

</tasks>

---

### PHASE 5 — Надёжность и верификация качества

#### Plan 5.1: per-subtask verification + partial-failure policy

```yaml
plan: 08-reliability
type: execute
wave: 4
depends_on: ["01-replan-core"]
files_modified:
  - src/modules/execution/verifier.ts
  - src/modules/execution/moe-executor.ts
  - src/core/agent-moe.ts
  - tests/modules/execution/moe-partial-failure.test.ts
must_haves:
  truths:
    - success_criteria сабтаска проверяются до merge; провал критерия = failed сабтаск
    - re-plan пересобирает только упавшие сабтаски; успешные не переисполняются
```

<tasks>

<task type="auto">
<name>Task 1: StepVerifier.verifySubtaskCriteria</name>
<files>src/modules/execution/verifier.ts</files>
<action>Новый метод: для каждого сабтаска проверяет машиночитаемые критерии — file-exists (пути из criteria/allowed_files), substring-in-file, command-exit-0 (безопасные команды через process registry, cap 30s). LLM-only критерии («код читаемый») НЕ проверять автоматически — помечаются warning и уходят в контекст verifyAndMerge Router'а. Результат мержится в решение сабтаска success/fail ДО verifyAndMerge.</action>
<verify>bun test tests/modules/execution/moe-partial-failure.test.ts</verify>
<done>Критерий "file exists" ловит сабтаск, который отчитался успехом, но файл не создал.</done>
</task>

<task type="auto">
<name>Task 2: selective re-plan</name>
<files>src/modules/execution/moe-executor.ts, src/core/agent-moe.ts</files>
<action>executePlan принимает `skipIds: Set<string>` — сабтаски из skip помечаются `status:"skipped-carried"` c переносом прошлого результата (без переисполнения). При re-plan: skip = все успешные id прошлых циклов. Зависимые от пропущенного получают его результат через input_from-механизм (Plan 1.2). Итоговый текст различает executed/carried.</action>
<verify>bun test tests/modules/execution/moe-partial-failure.test.ts && bunx tsc --noEmit</verify>
<done>Сценарий 3 сабтасков, средний упал: re-plan переисполняет только его, 1 и 3 — carried, общий success:true.</done>
</task>

</tasks>

#### Plan 5.2: Certification + документация

```yaml
plan: 09-certification-docs
type: execute
wave: 5
depends_on: ["08-reliability"]
files_modified:
  - src/modules/certification/scenarios.ts
  - AGENTS.md
  - docs/specs/2025-07-30-agent-level-moe.md
  - docs/small-model-observations.md
must_haves:
  truths:
    - mma model certify --tags moe прогоняет MoE-сценарии против реальной модели
```

<tasks>

<task type="auto">
<name>Task 1: moe certification suite</name>
<files>src/modules/certification/scenarios.ts</files>
<action>2 сценария tag=moe: (a) задача из 3 независимых файлов (параллельные волны, факт-чек всех трёх); (b) задача с зависимостью read-after-write (input_from: данные из step1 используются step2, факт-чек итогового содержимого). Config override: moe.enabled=true + orchestrator на той же модели. timeoutMs 600_000 (по опыту сценария 3.5).</action>
<verify>bun test tests/cert-scenario-rerun.test.ts</verify>
<done>Сценарии валидны, грузятся, fact-checks детерминированы (никаких сетевых зависимостей).</done>
</task>

<task type="auto">
<name>Task 2: docs sync</name>
<files>AGENTS.md, docs/specs/2025-07-30-agent-level-moe.md, docs/small-model-observations.md</files>
<action>Спека: статус Draft → Implemented (перечень реализованных post-MVP пунктов), раздел Post-MVP обновить (scope expansion сделан). AGENTS.md: переписать раздел Agent-Level MoE — новые конфиги (moe.maxReplanCycles, ExpertConfig.description), механика re-plan/scope_request/input_from, cert-тег moe. Все наблюдения за маленькими моделями из прогонов — в журнал наблюдений.</action>
<verify>Ручная сверка разделов; bun test зелёный.</verify>
<done>Документация соответствует коду, известные ограничения пересчитаны.</done>
</task>

</tasks>

---

## 4. Порядок работ и риски

| # | План | Почему этим порядком |
|---|---|---|
| 1 | 1.1 re-plan core | Без него остальные улучшения бесмысленны — главный механизм мёртв |
| 2 | 1.2 input_from | Независим, но нужен Plan 5.1 (carried results) |
| 3 | 2.1 scope_request | Зависит от re-plan (reject → re-plan path) |
| 4 | 4.1 abort | Независим; обязательно до «основного режима» |
| 5 | 3.1, 3.2 Router quality | После того как механика стабильна |
| 6 | 4.2 observability | До certification — иначе нечем диагностировать прогоны |
| 7 | 5.1 reliability | Верификация критериев + selective re-plan |
| 8 | 5.2 certification + docs | Финальный гейт: метрика «надёжнее single-agent» |

**Риски:**

- **Router на 9B** — качество JSON-планов. Смягчение: dynamic experts (меньше галлюцинаций тегов),
  validate+autofix перед КАЖДЫМ исполнением (уже есть — применять и к re-plan планам),
  certification даст метрику.
- **Петли scope_request** — лимит 2 цикла/сабтаск, потом reject.
- **Стоимость** — MoE всегда дороже по токенам (Router + verify + повторы). Cost breakdown
  (Plan 4.2) делает это видимым; решение «MoE vs single» остаётся за пользователем (moe.enabled).
- **Rule #10** — никакого keyword-matching для выбора режима/эксперта; выбор только через
  LLM-планирование или явный конфиг.

**Definition of Done (фичи в целом):**

- [ ] Все планы Wave 1-5 выполнены, `bun test` + `tsc --noEmit` зелёные
- [ ] Cert suite `moe`: обе реплики ≥ 2/3 на qwen3.5-9b (или зафиксированное observation)
- [ ] Esc прерывает MoE-прогон без orphan-процессов
- [ ] `session show` показывает полный MoE-постмортем (план, сабтаски, re-plan, cost)
- [ ] Спека и AGENTS.md отражают реализацию
