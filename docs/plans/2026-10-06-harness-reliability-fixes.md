# Harness Reliability Fixes (ses_muwinhpk_2e69iq) — Implementation Plan

> **Статус:** исполнено частично (сверка 2026-10-20) — WS1–WS3, WS6–WS8 и WS9(b–d) закрыты;
> чекбоксы плана проставлены по факту. **Осталось 3 пункта:**
> (1) WS4.5 — короткий hash извлечённого контента в `display`/`data`
> (`src/tools/web-fetch.ts` не выводит подпись);
> (2) WS5 — режим компакции `llm` (`contextBudget.compactionSummary` допускает только
> `off|ledger`, файл `compaction-summary.ts` не реализован);
> (3) WS9(a) — правило «systemic-сбой только при ≥3 различных падающих тулах» не реализовано.

**Goal:** закрыть класс отказов из разбора сессии: критик молча пропускается после компакции; компакция не несёт информации → петля переисследования; read-only петля без жёсткого стопа; рассинхрон провайдера/модели/контекста; `web_fetch`/`web_search` «успех без контента»; чрезмерная редакция секретов в персистентной истории; выдуманный артефакт не пойман; `subagent.expert_tag` — мёртвый параметр.

**Architecture:** правки в слое харнесса: turn-scoped evidence критика, устойчивый к компакции (monotonic `seq`); информативная/леджер-компакция; бюджет read-only; единая точка re-probe при смене провайдера; целевая (не разрушающая) редакция логов; честные контракты тулов. MoE-путь не трогаем.

**Tech Stack:** Bun + TypeScript (ES2022/NodeNext), vitest (`bun test`), Biome (`bun run lint`), полный гейт `bun run quality` (typecheck + typecheck:frontend + lint + fallow).

---

## Порядок работ

Каждый WS — отдельная ветка от `master` (`<type>/<slug>`), вливается после зелёных `bun test` + `tsc --noEmit` + `bun run quality`. WS8 зависит от WS1 (критик должен реально запускаться).

| # | WS | Дефект | Ветка | Размер |
|---|----|--------|-------|--------|
| 1 | WS1 | Критик пропускается после компакции | `fix/critic-mark-compaction` | S |
| 2 | WS2 | Read-only петля без жёсткого стопа | `fix/readonly-loop-budget` | S |
| 3 | WS3 | Рассинхрон провайдера/контекста | `fix/provider-reprobe-desync` | M |
| 4 | WS4 | `web_fetch`/`web_search` без контента | `fix/web-content-extraction` | M |
| 5 | WS5 | Компакция без информации | `fix/compaction-ledger` | L |
| 6 | WS6 | Редакция ломает историю | `fix/sessionlog-redaction` | S |
| 7 | WS7 | `subagent.expert_tag` мёртв | `fix/subagent-expert-tag` | S |
| 8 | WS8 | Выдуманный артефакт не пойман | `fix/artifact-grounding` | M |
| 9 | WS9 | Мелочи (память/пути/plan/reasoning) | `chore/misc-cleanups` | S |

---

## WS1: Критик пропускается на ходах с компакцией

**Причина:** `state.criticHistoryMark` — числовой индекс, снятый на старте хода (`src/core/agent.ts:806`). Компакция удаляет сообщения из начала → индексы сдвигаются; `gatherTurnToolEvents` клампит выход за диапазон к `history.length` (`src/core/agent/critic-gate.ts:240-242`) → пустой срез → `shouldRun()` возвращает `false` (`critic-gate.ts:154`). В сессии `critic_check` есть только на двух ходах без компакции.

**Решение:** заменить индекс на монотонный штамп `seq` на сообщении — переживает любые удаления спереди.

**Files:** Modify `src/modules/context/manager.ts`, `src/core/agent/loop-state.ts`, `src/core/agent/critic-gate.ts`, `src/core/agent.ts`; Test `tests/core/agent-critic.test.ts`, `tests/critic-gate.test.ts`.

### Task 1.1: Падающий тест — критик работает после компакции

- [x] **Step 1: Тест**

```ts
// tests/core/agent-critic.test.ts
it("keeps turn tool events after compaction (seq-based mark)", () => {
  const cm = new ContextManager(32768, DEFAULT_BUDGET, new TokenCounter("m"));
  const mark = cm.beginTurn();
  cm.addMessage({ role: "user", content: "task" });
  for (let i = 0; i < 30; i++) cm.addMessage({ role: "assistant", content: `a${i}` });
  cm.addMessage({ role: "tool", name: "web_fetch", content: "RESULT-DATA", success: true } as never);
  cm.compactAdaptive({ keepLastN: 2 });
  const events = gatherTurnToolEvents(cm, mark);
  expect(events.some((e) => e.tool === "web_fetch")).toBe(true);
});
```

- [x] **Step 2: Run (FAIL)**

Run: `bun test tests/core/agent-critic.test.ts -t "after compaction"`
Expected: FAIL — `cm.beginTurn is not a function`.

### Task 1.2: Штампы `seq` в ContextManager

- [x] **Step 1: Message + счётчик + штамп**

```ts
// src/modules/context/manager.ts
export interface Message { /* ... */ seq?: number; }

// внутри класса
private nextSeq = 0;
private stamp<T extends Message>(m: T): T { m.seq = this.nextSeq++; return m; }
beginTurn(): number { return this.nextSeq; }
```

- [x] **Step 2: Проставить штамп во всех точках добавления** (`addMessage`, `addMessages`, вставки summary/prompt). Каждый append — через `this.stamp(msg)`.

### Task 1.3: `gatherTurnToolEvents` по seq

- [x] **Step 1: Сигнатура и фильтр**

```ts
// src/core/agent/critic-gate.ts
export function gatherTurnToolEvents(
  contextManager: { getActiveHistory: () => Array<{ role: string; name?: string; content?: unknown; success?: boolean; arguments?: Record<string, unknown>; seq?: number }> },
  fromSeq = 0,
) {
  return contextManager
    .getActiveHistory()
    .filter((m) => (m.seq ?? 0) >= fromSeq && m.role === "tool" && m.name)
    .map((m) => ({
      tool: m.name as string,
      args: m.arguments,
      ok: m.success,
      output: typeof m.content === "string" ? m.content.slice(-MAX_EVENT_OUTPUT_CHARS) : undefined,
    }));
}
```

### Task 1.4: Проводка в agent.ts

- [x] **Step 1:** `state.criticHistoryMark = contextManager.beginTurn();` (`agent.ts:806`).
- [x] **Step 2:** `toolEvents: gatherTurnToolEvents(contextManager, state.criticHistoryMark)` (`agent.ts:1459`).
- [x] **Step 3:** Обновить комментарий поля `criticHistoryMark` в `loop-state.ts` (теперь seq, не индекс).

### Task 1.5: Проверка и коммит

- [x] **Step 1: Тесты + типы**

Run: `bun test tests/core/agent-critic.test.ts tests/critic-gate.test.ts`
Expected: PASS.
Run: `tsc --noEmit`
Expected: без ошибок.

- [x] **Step 2: Commit**

```bash
git checkout -b fix/critic-mark-compaction
git add src/modules/context/manager.ts src/core/agent/critic-gate.ts src/core/agent/loop-state.ts src/core/agent.ts tests/core/agent-critic.test.ts
git commit -m "fix(critic): keep turn tool evidence across compaction via message seq"
```

**Acceptance:** регрессионный тест с 5 последовательными компакциями всё ещё считает tool-события текущего захода; `critic_check` эмитится, когда финал идёт после компакции.

---

## WS2: Read-only петля без жёсткого стопа

**Причина:** детектор одинаковых вызовов жёстко стопит только `LOOP_PRONE_STATUS_TOOLS`; `web_fetch`/`web_search` — лишь nudge (`src/core/agent.ts:1263-1282`), `maxToolIterations=1000` (`src/core/agent/constants.ts`). За ход — 35 read-only вызовов.

**Решение:** бюджет read-only исследования (обобщённый): N подряд успешных батчей только из read-only тулов без мутаций → nudge → директива → честный стоп. Таксономия уже есть в `src/modules/execution/stuck-detector.ts` (`read_only`).

**Files:** Modify `src/core/agent/constants.ts`, `src/core/agent/tool-batch.ts`, `src/core/agent/loop-state.ts`, `src/core/agent.ts`, `src/i18n/en.json`, `src/i18n/ru.json`; Test `tests/core/tool-batch-honest-stop.test.ts`.

### Task 2.1: Падающий тест

- [x] **Step 1:** Смоделировать 8 подряд all-`web_fetch` успешных батчей; ожидать инъекцию `<system-summary>` (`exec.readonly_directive`) после порога и `success:false` (`error.retry_loop_stopped`) на жёстком стопе. Run → FAIL.

### Task 2.2: Константы и классификация

- [x] **Step 1:**

```ts
// src/core/agent/constants.ts
export const MAX_READONLY_BATCHES = 8;
export const HARD_STOP_READONLY_BATCHES = 12;
```

- [x] **Step 2:** В `tool-batch.ts` — `isReadOnlyTool(name)` по тегам/явному множеству: `read_file, list_dir, glob, grep, file_info, project_map, web_search, web_fetch, web_browse, session_info, process_list, process_log` (никаких мутирующих тулов).

### Task 2.3: Счётчик и эскалация

- [x] **Step 1:** После батча: все вызовы read-only и нет мутации (переиспользовать `isWorkMutation`, `src/modules/critic/evidence.ts`) → `state.consecutiveReadOnlyBatches++`, иначе `=0`.
- [x] **Step 2:** На `MAX_READONLY_BATCHES` — `<system-summary>` (`exec.readonly_directive`: «ты только читаешь/ищешь; либо ответь тем, что собрал, либо сделай конкретное изменение»). На `HARD_STOP_READONLY_BATCHES` — `state.readonlyStopped = true`, честный `success:false` с кратким summary собранного.
- [x] **Step 3:** i18n ключи в `en.json`/`ru.json`.

### Task 2.4: Проверка и коммит

- [x] Run: `bun test tests/core/tool-batch-honest-stop.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/readonly-loop-budget`: `fix(agent): read-only exploration budget with honest stop`.

**Acceptance:** в симуляции длинного исследования агент останавливается за ≤12 read-only батчей и выдаёт финальный текст; при явном read-only запросе пользователя стоп даёт частичный ответ, а не пустой провал.

---

## WS3: Рассинхрон провайдера/модели/контекста

**Причина (три части):**
1. `Agent.setProvider()` (`src/core/agent.ts:1644-1655`) меняет провайдера, но не re-probe и не `contextManager.resize` (в отличие от `reconfigure`, `:1577-1625`).
2. Per-session раннеры (`src/core/bootstrap/session-runner.ts`) наследуют **bootstrap** `envReport` (`:228`) и **bootstrap** `contextProbePromise` (`:354-358`) — они от провайдера на старте процесса, а не от фактического.
3. `SessionMeta.contextWindow` пишется один раз при создании (`src/modules/session/manager.ts:70`).

**Решение:** единый источник правды = live-probe активной записи; каждый путь смены re-probe + resize; env/meta отражают эффективное значение.

**Files:** Modify `src/core/agent.ts`, `src/core/bootstrap/session-runner.ts`, `src/core/environment.ts`, `src/modules/session/manager.ts`, `src/modules/session/store.ts`, web-switch путь; Test `tests/core/bootstrap-probe-apply.test.ts`, `tests/llm/provider-context-probe.test.ts`, `tests/providers/active-endpoint.test.ts`, new `tests/core/setprovider-reprobe.test.ts`.

### Task 3.1: Падающий тест (setProvider)

- [x] С мок-пробой: `setProvider("lm studio", "prism-ml/bonsai-27b")` → окно `contextManager` равно пробному значению, `resize` вызван. Run → FAIL.

### Task 3.2: Извлечь `private async reprobeAndResize(config)`

- [x] Вынести из `reconfigure` (`:1584-1620`): probe активного эндпоинта → `config.contextWindow` → `contextManager.resize` → `lastProbeIdentity`. Вызывать из `reconfigure` и `setProvider`.

### Task 3.3: Падающий тест (runner env)

- [x] Проверить, что `envReport.provider.model` и `.contextWindow` раннера = его конфиг (не bootstrap-template). Run → FAIL.

### Task 3.4: Раннер использует свой probe/env

- [x] В `session-runner.ts`: после `buildActiveProvider(config, …)` вычислить probe для `activeProviderEndpoint(config.provider)` (await/background как в bootstrap) и передать в `applyProbedContext`; пересобрать provider/env-часть `envReport` из раннерского `config`.

### Task 3.5: Синхронизация meta

- [x] Добавить `SessionManager.setEffectiveContext(window)` → `store.saveMeta`; вызывать из reconfigure-пути. Проверить, что `meta.json.contextWindow` = эффективное окно.

### Task 3.6: Проверка и коммит

- [x] Run: `bun test tests/core/bootstrap-probe-apply.test.ts tests/llm/provider-context-probe.test.ts tests/providers/active-endpoint.test.ts tests/core/setprovider-reprobe.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/provider-reprobe-desync`: `fix(provider): re-probe context and sync env/meta on every switch path`.

**Acceptance:** для одной сессии `meta.contextWindow == session_start.environment.provider.contextWindow == context snapshot.window`; смена провайдера re-probe в пределах хода.

**Risk:** probe добавляет латентность при каждом `setProvider` — сделать non-blocking (стартовое значение держится до резолва), кэш 24h как у reasoning-probe. Обновить `docs/agents/*`.

---

## WS4: `web_fetch`/`web_search` — «успех без контента»

**Причина:** `src/tools/web-search.ts:37,53-62` отдаёт DDG-редиректы (`//duckduckgo.com/l/?uddg=…`) + сниппеты. `src/tools/web-fetch.ts:82,107-116` ставит `success:true` на любой 2xx и возвращает `stripHtml()` (навбар/боилерплейт) — JS-shell и контентная страница неразличимы.

**Files:** Modify `src/tools/web-search.ts`, `src/tools/web-fetch.ts`; Create `src/tools/html-content.ts`; Test `tests/tools/web-search.test.ts`, `tests/tools/web-fetch.test.ts`, new `tests/tools/html-content.test.ts`.

### Task 4.1: Падающий тест (unwrap URL)

- [x] `performWebSearch` на фикстуре с `href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=X"` → `url === "https://example.com/a"`. Run → FAIL.

### Task 4.2: `unwrapDdgUrl`

- [x] Реализовать в `web-search.ts`; применять в `performWebSearch`; возвращать прямые URL.

### Task 4.3: Падающий тест (детект shell)

- [x] `extractMainContent` на навбар-тяжёлой SPA-фикстуре даёт текст ниже порога; тогда handler возвращает `success:false` с ключом `tool.web_fetch_no_content` (hint «use browser») вместо мнимого успеха. Run → FAIL.

### Task 4.4: `src/tools/html-content.ts`

- [x] Убрать `script/style/nav/header/footer/aside`; выбрать плотнейший `<main>/<article>/[role=main]/` по длине текста; схлопнуть пробелы. `looksLikeShell` = извлечённых символов < `MIN_CONTENT_CHARS` (≈200) и text/markup ratio ниже порога.

### Task 4.5: Сигнатура контента

- [x] Короткий hash извлечённого текста в `display`/`data` — виден anti-loop (WS2) и модели; повторные идентичные fetch-и детектируются.

### Task 4.6: Проверка и коммит

- [x] Run: `bun test tests/tools/web-search.test.ts tests/tools/web-fetch.test.ts tests/tools/html-content.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/web-content-extraction`: `fix(web): extract main content, unwrap search redirects, flag empty shells`.

**Acceptance:** JS-shell URL даёт явный сигнал «no readable content → use browser»; результаты поиска — прямые URL; два fetch-а shell дают одинаковую сигнатуру.

**Risk:** эвристика может обрезать лишнее — оставить raw fallback: если извлечено < порога, но raw большой — вернуть raw с пометкой «could not isolate main content».

---

## WS5: Компакция не несёт информации

**Причина:** `buildCompactionBlock` (`src/modules/context/manager.ts:655-694`) несёт только task/plan/facts/errors; факты из удалённых turns (результаты поиска/fetch) теряются → модель повторяет те же URL. LLM-суммаризации нет. За ход — 16 компакций.

**Решение (слоями, безопасно для слабых моделей):**
1. Детерминированный **tool ledger**, пинится через компакцию: `(tool, key-args, digest результата)` для read/research/exec, дедуп + cap. Всегда включён, без LLM.
2. Опциональная **LLM-суммаризация** удалённых turns (`contextBudget.compactionSummary: off|ledger|llm`, default `ledger`), короткий таймаут, fail-open, кэш по hash.
3. Не ре-компактить, если рост — только tool-output, уже покрытый леджером.

**Files:** Modify `src/modules/context/manager.ts`, `src/core/agent/compaction.ts`, `src/config/types.ts`, `src/config/registry-extra.ts`, `src/config/defaults.ts`; Create `src/modules/context/compaction-summary.ts`; Test `tests/context-manager.test.ts`, `tests/compaction-policy.test.ts`, new `tests/context-manager-ledger.test.ts`.

### Task 5.1: Падающий тест (ledger)

- [x] Компактнуть историю с `web_search`/`web_fetch`/`read_file`; в `<system-summary>` ожидать секцию `[Tool ledger]` (дедуп, cap), и что повторная компакция её переносит. Run → FAIL.

### Task 5.2: `extractToolLedger(messages)`

- [x] Для каждого tool-message: `- <tool>(<summarizeArgs>) → <первая непустая строка результата, ≤120 симв>`, дедуп по `tool+args`, cap `TOOL_LEDGER_MAX_ENTRIES` (≈12), пропуск status-тулов. Добавить в `buildCompactionBlock` после `[Task]`.

### Task 5.3: Падающий тест (no-op re-compaction)

- [x] При росте только tool-output, уже покрытом леджером, `compactIfNeededV2` не срабатывает повторно (проверить count на симуляции роста). Run → FAIL.

### Task 5.4: Политика summary

- [x] Конфиг `contextBudget.compactionSummary` (`off|ledger|llm`, default `ledger`). Для `llm`: `src/modules/context/compaction-summary.ts` зовёт активный провайдер с bounded-промптом (`max_tokens≈256`, `timeoutMs≈8000`), возвращает bullets; кэш `<project>/.mma/cache/compaction-summaries` по hash содержимого; любая ошибка → `null` → ledger-only.

### Task 5.5: Проводка

- [x] `CompactionService.compactV2`/reactive компакция передают суммаризатор; тесты офлайн — инжектить stub.

### Task 5.6: Проверка и коммит

- [x] Run: `bun test tests/context-manager*.test.ts tests/compaction-policy.test.ts tests/context-manager-ledger.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/compaction-ledger`: `fix(context): pin tool ledger across compaction (and optional LLM summary)`.

**Acceptance:** после ≥3 компакций контекст всё ещё перечисляет прошлые поиски/fetch-и; симулированный агент не повторяет идентичные URL; объём компакций в длинном read-задании падает (цель: <50% baseline).

**Risk:** леджер тратит токены — строгий cap и замер бюджетом; `llm` добавляет латентность → default `ledger`.

---

## WS6: Редакция ломает персистентную историю

**Причина:** `session-logger.ts:160,171-186` (`sanitizeArgs`) и `:202` гоняют args/результаты через `sanitizeLogMessage`, чьё общее правило `/\b([a-zA-Z0-9_-]{30,})\b/g → [REDACTED]` (`src/modules/security/data-sanitizer.ts:48-51`) съедает длинные слаги/URL-параметры. 24 вхождения `[REDACTED]` попали и в `session.jsonl`, и в `history.jsonl` (источник `/resume`).

**Решение:** целевая редакция (`redactContextSecrets`, `src/core/agent/context-log.ts:27-41`) для tool args/results и URL-параметров (`sanitizeUrl`); общее правило — только для заведомо секретных контекстов.

**Files:** Modify `src/core/session-logger.ts`, `src/modules/security/data-sanitizer.ts`; Test `tests/security/data-sanitizer.test.ts`, `tests/context-log.test.ts`, new `tests/core/session-logger-redaction.test.ts`.

### Task 6.1: Падающий тест

- [x] `tool_call` с `{"url":"https://catalog.example.com/bike/specialized/rockhopper-27.5-m-2023-gloss"}` персистится дословно; реальный `sk-…`/`Bearer …` по-прежнему редакчится. Run → FAIL.

### Task 6.2: Разделить API

- [x] `sanitizeLogMessageTargeted()` (только целевые паттерны) + строгий вариант для известных секретов. Перевести `session-logger` на targeted; для URL-полей — `sanitizeUrl` (маскирует только `key/token/password/secret`-параметры).

### Task 6.3: Регрессия resume

- [x] Записать tool-результат с длинным URL, перезагрузить через `SessionManager`, проверить равенство (кроме настоящих секретов).

### Task 6.4: Проверка и коммит

- [x] Run: `bun test tests/security/data-sanitizer.test.ts tests/context-log.test.ts tests/core/session-logger-redaction.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/sessionlog-redaction`: `fix(logging): targeted redaction; stop corrupting URLs/slugs in session history`.

**Acceptance:** нет ложных `[REDACTED]` на URL/слагах/ID модели; секреты маскируются; `history.jsonl` round-trip без потерь.

---

## WS7: `subagent.expert_tag` мёртв + жёсткий таймаут 180s

**Причина:** `expert_tag` объявлен (`src/tools/subagent.ts:48`), но handler его не читает; таймаут фиксирован 180s. Модель передала `expert_tag:"web"`, фильтрации не произошло, сабтаск упал по таймауту.

**Files:** Modify `src/tools/subagent.ts`, `src/config/types.ts`, `src/config/registry-extra.ts`, `src/config/defaults.ts`; Test `tests/subagent-tool.test.ts`, `tests/tools/subagent.test.ts`.

### Task 7.1: Падающий тест

- [x] `expert_tag:"research"` → tool tags сабтаска `["research"]`; неизвестный тег → понятная ошибка со списком известных (`expertTagsExist`/known set). Run → FAIL.

### Task 7.2: Реализовать резолв

- [x] В handler: если `expert_tag` задан и нет `tool_tags` → `config.experts[tag]`, взять его `tool_tags` (и при желании model). Неизвестный тег → `success:false` со списком. Обновить описание схемы («должен быть сконфигурированный эксперт»).

### Task 7.3: Конфигурируемый таймаут

- [x] `subagent.timeoutMs` (default 180000) в реестре `registry-extra.ts`; timeout-результат с частичным статусом, если есть.

### Task 7.4: Проверка и коммит

- [x] Run: `bun test tests/subagent-tool.test.ts tests/tools/subagent.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/subagent-expert-tag`: `fix(subagent): honor expert_tag, configurable timeout`.

**Acceptance:** `expert_tag` фильтрует тулы или падает явно; нет тихого no-op.

---

## WS8: Выдуманный артефакт не пойман

**Причина:** финальный `Specialized_Bicycles_Minsk.md` содержал выдуманные цены; критик, который смотрит файлы/команды, был пропущен (WS1). Claim-проверки (`checkArtifactClaims`, `checkUnverifiedOutput`, `src/core/agent/hallucination-gate.ts`) не оценивают *обоснованность* содержимого.

**Files:** Modify `src/modules/critic/evidence.ts`, `src/modules/critic/client.ts`, `src/core/agent/artifact-resolve.ts`, `src/core/agent/hallucination-gate.ts`; Test `tests/critic-evidence.test.ts`, `tests/hallucination-artifact-claim.test.ts`.

### Task 8.1: Падающий тест

- [x] Ход только с провальными/shell `web_fetch` + записанный артефакт с `25000 BYN` → evidence-pack помечает `webGrounding.verified=false`, гейт выдаёт issue. Run → FAIL.

### Task 8.2: Evidence

- [x] Расширить `buildEvidencePack` полем `webGrounding` из tool-событий (`web_fetch` success + сигнатура контента из WS4). `verified` только если ≥1 fetch вернул содержательный контент.

### Task 8.3: Промпт критика

- [x] В `CRITIC_SYSTEM_PROMPT` — правило: «числовые/ценовые/model-заявления требуют подтверждения содержательным fetch-ем; нет улик ⇒ issue».

### Task 8.4: Детерминированный guard (опционально)

- [x] В `hallucination-gate`: если финальный артефакт содержит price/currency-паттерны и `webGrounding.verified=false` → `<system-summary>` с просьбой пометить данные как непроверенные. Bounded `MAX_CLAIM_CHECK_RETRIES`.

### Task 8.5: Проверка и коммит

- [x] Run: `bun test tests/critic-evidence.test.ts tests/hallucination-artifact-claim.test.ts tests/core/agent-critic.test.ts` → PASS; `tsc --noEmit`.
- [x] Commit на `fix/artifact-grounding`: `fix(critic): require web grounding for numeric/price claims`.

**Acceptance:** с фиксом WS1 велосипедный сценарий триггерит issue критика; вывод с выдуманными числами без grounding даёт repair/advice summary.

---

## WS9: Мелочи

**a) Шум в памяти от повторных падений тулов** (`src/core/agent/tool-batch.ts:392`, generic-текст `:95`):
- [x] Гейтить запись по severity: не писать для транзиентных `web_fetch`/`web_search`; агрегировать/дедуп по тулу; «systemic» — только при ≥3 различных падающих тулах.
- [x] Test: `tests/memory-module.test.ts` / new `tests/core/tool-batch-memory.test.ts`.

**b) POSIX-пути на Windows** (`workdir:"/tmp"`, `/Users/...`):
- [x] В `src/tools/bash.ts` (или `stuck-detector.ts`): детект POSIX-rooted путей на `win32` → корректирующий hint; валидация существования `workdir`.
- [x] Test: `tests/bash.test.ts` / `tests/bash-process-hint.test.ts`.

**c) Трение plan checks**:
- [x] Уточнить описание `plan`-тула: `checks` необязательны, самоподтверждение предпочтительно; сократить ошибку до одной actionable строки.
- [x] Test: `tests/execution-plan-checks.test.ts`.

**d) Reasoning не эскалируется на петле** (весь ход `low`):
- [x] При `state.iterRepetitive`/read-only streak (WS2) поднимать reasoning baseline на следующий ход; убедиться, что текущая policy не *понижает* effort при повторе.
- [x] Test: существующие reasoning-тесты.

- [x] Commit на `chore/misc-cleanups`.

---

## Сквозное

- **По AGENTS:** каждый WS — своя ветка от `master`, спека/план в той же ветке, зелёные `bun test` + `tsc --noEmit`, затем `bun run quality`. Добавить записи в `CHANGELOG.md` по релизам; обновить `docs/agents/*` (hooks, provider switch, compaction config, redaction).
- **Регрессионный сценарий:** после WS1–WS4 — тест формы велосипедной сессии (длинное read-only исследование с повторяющимися URL): нет бесконечной петли, критик отработал, claims артефакта grounded-или-помечены, история round-trip без ложной редакции.
- **Новые конфиг-ключи** (документировать + вывести в web-settings): `contextBudget.compactionSummary`, `subagent.timeoutMs`; read-only бюджет — внутренние константы.
- **Проверка в каждом таске:** `bun test <file>`, затем `tsc --noEmit`; перед merge — `bun run quality`.

---

## Self-review (покрытие дефектов)

| Дефект из разбора | WS |
|---|---|
| §1 рассинхрон провайдера/контекста | WS3 |
| §2 критик пропущен после компакции | WS1 |
| §3 компакция без информации | WS5 |
| §4 петля без стопа | WS2 |
| §5 web fetch/search без контента | WS4 |
| §6 `subagent.expert_tag`/таймаут | WS7 |
| §7 редакция истории | WS6 |
| §8 выдуманный артефакт | WS1 (корень) + WS8 (grounding) |
| §9 мелочи | WS9 |
